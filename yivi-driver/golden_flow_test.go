package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/privacybydesign/irmago/irma"
)

// TestGoldenFlow is EPIC issue #205 (P0.3): the full happy path — a file is
// sealed + signed, uploaded to cryptify (which emails the recipient), then
// downloaded and DECRYPTED after a headless Yivi disclosure. Every contract is
// exercised: pg-wasm wire format (oracle), the PKG key endpoints, cryptify, and
// the Yivi disclosure (driver). No phone, no browser.
//
// A single headless holder plays both sender (signs via Yivi) and recipient
// (decrypts via Yivi) — splitting them across two identities is a follow-up.
//
//	cd ../stack && docker compose up -d
//	go test -run TestGoldenFlow -v
func TestGoldenFlow(t *testing.T) {
	pkgURL := env("PG_PKG_URL", "http://localhost:8087")
	irmaURL := env("PG_IRMA_URL", "http://localhost:8088")
	cryptifyURL := env("PG_CRYPTIFY_URL", "http://localhost:8000")
	mailcrabURL := env("PG_MAILCRAB_URL", "http://localhost:1080")
	schemesAssets := filepath.Join(env("IRMAGO_ROOT", "../../irmago"), "testdata", "irma_configuration")

	if !reachable(pkgURL+"/health") || !reachable(cryptifyURL+"/health") {
		t.Skipf("stack not reachable (PKG %s, cryptify %s) — cd ../stack && docker compose up -d", pkgURL, cryptifyURL)
	}

	const (
		attrType    = "irma-demo.RU.studentCard.level"
		attrVal     = "PhD"
		recipientID = "phd-holder"
	)
	ts := time.Now().Unix()
	// Unique per run so the mailcrab assertion below can't match a notification
	// left over from a previous run against the same live stack.
	recipientEmail := fmt.Sprintf("recipient+%d@golden.test", time.Now().UnixNano())
	plaintext := []byte("golden-flow: the eagle lands at 0400")

	// Headless holder, issued the credential it will disclose for both roles.
	work := t.TempDir()
	d, err := NewYiviDriver(filepath.Join(work, "client"), schemesAssets, filepath.Join(work, "eudi"))
	if err != nil {
		t.Fatalf("build holder: %v", err)
	}
	defer d.Close()

	iss := irma.NewIssuanceRequest([]*irma.CredentialRequest{{
		CredentialTypeID: irma.NewCredentialTypeIdentifier("irma-demo.RU.studentCard"),
		Attributes: map[string]string{
			"university": "Radboud University", "studentCardNumber": "0812345673",
			"studentID": "s1234567", "level": attrVal,
		},
	}})
	issQR, err := issueViaServer(irmaURL, iss)
	if err != nil {
		t.Fatalf("issuance start: %v", err)
	}
	if err := d.RunSession(issQR); err != nil {
		t.Fatalf("issuance: %v", err)
	}

	// Complete a PKG-initiated disclosure of attrType, returning the JWT.
	discloseViaPKG := func(what string) string {
		sp, token, err := pkgStartDisclosure(pkgURL, irmaAuthRequest{Con: []conItem{{T: attrType}}, Validity: 300})
		if err != nil {
			t.Fatalf("%s: pkg start: %v", what, err)
		}
		if err := d.RunSession(sp); err != nil {
			t.Fatalf("%s: disclose: %v", what, err)
		}
		jwt, err := pkgPollJWT(pkgURL, token)
		if err != nil {
			t.Fatalf("%s: poll jwt: %v", what, err)
		}
		return jwt
	}

	// --- SENDER: fetch signing key via a business API key, then seal + sign ---
	// With API-key auth the PKG fills the signing identity (incl. the
	// pbdf.sidn-pbdf.email.email that cryptify requires) from the business DB,
	// so no sender disclosure is needed. The request body is ignored.
	mpk, err := pkgPublicKey(pkgURL + "/v2/parameters")
	if err != nil {
		t.Fatalf("mpk: %v", err)
	}
	apiKey := env("PG_API_KEY", "PG-goldenflowe2ekey")
	pub, priv, err := pkgFetchSigningKey(pkgURL, apiKey, []conItem{})
	if err != nil {
		t.Fatalf("signing key (api key): %v", err)
	}
	sealRes, err := runOracle(map[string]any{
		"op":  "seal",
		"mpk": mpk,
		"policy": map[string]any{
			recipientID: map[string]any{"ts": ts, "con": []conItem{{T: attrType, V: attrVal}}},
		},
		"pubSignKey":   pub,
		"privSignKey":  priv,
		"plaintextB64": base64.StdEncoding.EncodeToString(plaintext),
	})
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	var ctB64 string
	_ = json.Unmarshal(sealRes["ciphertextB64"], &ctB64)
	ct, _ := base64.StdEncoding.DecodeString(ctB64)
	t.Logf("sealed %d bytes", len(ct))

	// --- UPLOAD to cryptify (fires the notification email) ---
	uuid, err := cryptifyUpload(cryptifyURL, recipientEmail, ct)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	t.Logf("uploaded uuid=%s", uuid)

	// --- ASSERT the notification email reached mailcrab ---
	mailOK := false
	for i := 0; i < 20 && !mailOK; i++ {
		if ok, _ := mailcrabHasMessageTo(mailcrabURL, recipientEmail); ok {
			mailOK = true
		} else {
			time.Sleep(300 * time.Millisecond)
		}
	}
	if !mailOK {
		t.Errorf("no notification email to %s captured in mailcrab", recipientEmail)
	} else {
		t.Logf("notification email to %s captured in mailcrab", recipientEmail)
	}

	// --- RECIPIENT: download, fetch USK via Yivi, unseal ---
	dl, err := cryptifyDownload(cryptifyURL, uuid)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	vk, err := pkgPublicKey(pkgURL + "/v2/sign/parameters")
	if err != nil {
		t.Fatalf("vk: %v", err)
	}
	usk, err := pkgFetchUSK(pkgURL, discloseViaPKG("decrypt"), ts)
	if err != nil {
		t.Fatalf("usk: %v", err)
	}
	unsealRes, err := runOracle(map[string]any{
		"op":            "unseal",
		"ciphertextB64": base64.StdEncoding.EncodeToString(dl),
		"vk":            vk,
		"recipientId":   recipientID,
		"usk":           usk,
	})
	if err != nil {
		t.Fatalf("unseal: %v", err)
	}
	var ptB64 string
	_ = json.Unmarshal(unsealRes["plaintextB64"], &ptB64)
	got, _ := base64.StdEncoding.DecodeString(ptB64)
	if string(got) != string(plaintext) {
		t.Fatalf("decrypted mismatch:\n got:  %q\n want: %q", got, plaintext)
	}

	// Assert the cryptographically verified sender identity — the whole point
	// of signing is that the recipient learns who sent it.
	const wantSender = "sender@golden.test"
	var senderID struct {
		Public struct {
			Con []struct {
				T string `json:"t"`
				V string `json:"v"`
			} `json:"con"`
		} `json:"public"`
	}
	if err := json.Unmarshal(unsealRes["sender"], &senderID); err != nil {
		t.Fatalf("parse sender identity: %v (raw: %s)", err, string(unsealRes["sender"]))
	}
	foundSender := false
	for _, a := range senderID.Public.Con {
		if a.T == "pbdf.sidn-pbdf.email.email" && a.V == wantSender {
			foundSender = true
		}
	}
	if !foundSender {
		t.Fatalf("verified sender identity missing pbdf.sidn-pbdf.email.email=%s; got %s", wantSender, string(unsealRes["sender"]))
	}
	t.Logf("decrypted OK (%d bytes); verified sender=%s", len(got), wantSender)
}
