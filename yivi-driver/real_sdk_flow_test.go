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

// TestRealSdkGoldenFlow is the Phase 2 keystone (EPIC #201): the SAME happy
// path as TestGoldenFlow, but the crypto runs through the real, published
// @e4a/pg-js SDK (oracle ops sealSdk/decryptSdk) instead of the low-level
// pg-wasm primitives. This exercises the exact API surface the website and
// email add-ons ship — recipient addressed by email, API-key sender signing,
// and decryption via a session callback — end to end, headless.
//
// The Go test still owns Yivi (issue + disclose) and the cryptify transport;
// the SDK owns all PostGuard/PKG interaction (params, signing keys, USK) and
// the seal/unseal. The session callback receives the JWT the headless holder
// already produced — the standard pg-js "the host runs the session" contract.
//
//	cd ../stack && docker compose up -d
//	go test -run TestRealSdkGoldenFlow -v
func TestRealSdkGoldenFlow(t *testing.T) {
	pkgURL := env("PG_PKG_URL", "http://localhost:8087")
	irmaURL := env("PG_IRMA_URL", "http://localhost:8088")
	cryptifyURL := env("PG_CRYPTIFY_URL", "http://localhost:8000")
	mailcrabURL := env("PG_MAILCRAB_URL", "http://localhost:1080")

	if !reachable(pkgURL+"/health") || !reachable(cryptifyURL+"/health") {
		t.Skipf("stack not reachable (PKG %s, cryptify %s) — cd ../stack && docker compose up -d", pkgURL, cryptifyURL)
	}
	apiKey := env("PG_API_KEY", "")
	if apiKey == "" {
		t.Skip("PG_API_KEY not set")
	}

	const emailCred = "irma-demo.sidn-pbdf.email"
	emailAttr := emailAttribute()
	recipientEmail := fmt.Sprintf("recipient+%d@golden.test", time.Now().UnixNano())
	plaintext := []byte("real-SDK golden flow: sealed and opened by @e4a/pg-js")

	// Headless holder, issued the email credential it will disclose to decrypt.
	work := t.TempDir()
	d, err := NewYiviDriver(filepath.Join(work, "client"), schemeRoot(), filepath.Join(work, "eudi"))
	if err != nil {
		t.Fatalf("build holder: %v", err)
	}
	defer d.Close()

	iss := irma.NewIssuanceRequest([]*irma.CredentialRequest{{
		CredentialTypeID: irma.NewCredentialTypeIdentifier(emailCred),
		Attributes:       map[string]string{"email": recipientEmail, "domain": "golden.test"},
	}})
	issQR, err := issueViaServer(irmaURL, iss)
	if err != nil {
		t.Fatalf("issuance start: %v", err)
	}
	if err := d.RunSession(issQR); err != nil {
		t.Fatalf("issue email credential: %v", err)
	}

	// --- SENDER: seal via the real SDK (API-key signing; the SDK fetches MPK +
	// signing keys from the PKG itself). ---
	sealRes, err := runOracle(map[string]any{
		"op":             "sealSdk",
		"pkgUrl":         pkgURL,
		"apiKey":         apiKey,
		"recipientEmail": recipientEmail,
		"emailAttribute": emailAttr,
		"plaintextB64":   base64.StdEncoding.EncodeToString(plaintext),
	})
	if err != nil {
		t.Fatalf("sealSdk: %v", err)
	}
	var ctB64 string
	_ = json.Unmarshal(sealRes["ciphertextB64"], &ctB64)
	ct, _ := base64.StdEncoding.DecodeString(ctB64)
	if len(ct) == 0 {
		t.Fatal("sealSdk produced empty ciphertext")
	}

	// pg-js stamps the policy timestamp with Math.round(Date.now()/1000), which
	// can round UP to the next whole second — i.e. up to ~1s in the future. The
	// PKG rejects a USK request whose timestamp is > now ("chronology error").
	// In real usage the encrypt→decrypt gap is many seconds so it never shows;
	// this headless flow completes in <1s, so wait for the wall clock to catch
	// up. (See the pg-js Math.round note reported alongside this change.)
	time.Sleep(1500 * time.Millisecond)

	// --- UPLOAD to cryptify (fires the notification email) ---
	uuid, err := cryptifyUpload(cryptifyURL, recipientEmail, ct)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	t.Logf("SDK-sealed %d bytes, uploaded uuid=%s", len(ct), uuid)

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
	}

	// --- RECIPIENT: disclose the email credential -> JWT (headless) ---
	sp, token, err := pkgStartDisclosure(pkgURL, irmaAuthRequest{Con: []conItem{{T: emailAttr}}, Validity: 300})
	if err != nil {
		t.Fatalf("pkg start disclosure: %v", err)
	}
	if err := d.RunSession(sp); err != nil {
		t.Fatalf("holder disclose email: %v", err)
	}
	jwt, err := pkgPollJWT(pkgURL, token)
	if err != nil {
		t.Fatalf("poll jwt: %v", err)
	}

	// --- DECRYPT via the real SDK (session callback returns the JWT above; the
	// SDK fetches the USK and unseals). ---
	dl, err := cryptifyDownload(cryptifyURL, uuid)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	decRes, err := runOracle(map[string]any{
		"op":             "decryptSdk",
		"pkgUrl":         pkgURL,
		"ciphertextB64":  base64.StdEncoding.EncodeToString(dl),
		"jwt":            jwt,
		"recipientEmail": recipientEmail,
		"emailAttribute": emailAttr,
	})
	if err != nil {
		t.Fatalf("decryptSdk: %v", err)
	}
	var ptB64 string
	_ = json.Unmarshal(decRes["plaintextB64"], &ptB64)
	got, _ := base64.StdEncoding.DecodeString(ptB64)
	if string(got) != string(plaintext) {
		t.Fatalf("decrypted mismatch:\n got:  %q\n want: %q", got, plaintext)
	}

	// The SDK's parsed sender identity must carry the (business-DB) sender email.
	// Assert the value, not the attribute type — the type depends on the stack's
	// email-attribute knob, which TestGoldenFlow already pins.
	const wantSender = "sender@golden.test"
	var sender struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(decRes["sender"], &sender); err != nil {
		t.Fatalf("parse sender: %v (raw: %s)", err, string(decRes["sender"]))
	}
	if sender.Email != wantSender {
		t.Fatalf("SDK sender email = %q, want %q (raw: %s)", sender.Email, wantSender, string(decRes["sender"]))
	}
	t.Logf("real SDK round-trip OK (%d bytes); verified sender=%s", len(got), sender.Email)
}
