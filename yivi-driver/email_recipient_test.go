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

// TestEmailRecipientRoundTrip is the recipient half of the real-SDK flow
// (EPIC Phase 2): a file is sealed to a recipient identified by an actual
// irma-demo.sidn-pbdf.email.email credential, and decrypted only after the
// headless holder DISCLOSES that email credential to the PKG. This is the shape
// @e4a/pg-js is built around (recipients are addressed by email), so proving it
// headless is the prerequisite for driving the real SDK through the harness.
//
// Unlike TestGoldenFlow (which addresses the recipient by an RU.studentCard
// attribute), the recipient here is a real, issued-and-disclosed email — which
// only works because the stack now serves the published irma-demo scheme with
// sidn-pbdf.email + issuer keys (stack/schemes/provision.sh).
//
//	cd ../stack && docker compose up -d
//	go test -run TestEmailRecipientRoundTrip -v
func TestEmailRecipientRoundTrip(t *testing.T) {
	pkgURL := env("PG_PKG_URL", "http://localhost:8087")
	irmaURL := env("PG_IRMA_URL", "http://localhost:8088")
	cryptifyURL := env("PG_CRYPTIFY_URL", "http://localhost:8000")

	if !reachable(pkgURL+"/health") || !reachable(cryptifyURL+"/health") {
		t.Skipf("stack not reachable (PKG %s, cryptify %s) — cd ../stack && docker compose up -d", pkgURL, cryptifyURL)
	}
	apiKey := env("PG_API_KEY", "")
	if apiKey == "" {
		t.Skip("PG_API_KEY not set")
	}

	const emailCred = "irma-demo.sidn-pbdf.email"
	emailAttr := emailAttribute() // irma-demo.sidn-pbdf.email.email
	ts := time.Now().Unix()
	recipientEmail := fmt.Sprintf("recipient+%d@golden.test", time.Now().UnixNano())
	plaintext := []byte("email-recipient round-trip: addressed by a disclosed credential")

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
	t.Logf("issued %s = %s to holder", emailAttr, recipientEmail)

	// SENDER: API-key signing (PKG fills the sender identity from business-db);
	// seal to a recipient addressed by the email attribute.
	mpk, err := pkgPublicKey(pkgURL + "/v2/parameters")
	if err != nil {
		t.Fatalf("mpk: %v", err)
	}
	pub, priv, err := pkgFetchSigningKey(pkgURL, apiKey, []conItem{})
	if err != nil {
		t.Fatalf("signing key (api key): %v", err)
	}
	sealRes, err := runOracle(map[string]any{
		"op":  "seal",
		"mpk": mpk,
		"policy": map[string]any{
			recipientEmail: map[string]any{"ts": ts, "con": []conItem{{T: emailAttr, V: recipientEmail}}},
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

	uuid, err := cryptifyUpload(cryptifyURL, recipientEmail, ct)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	t.Logf("sealed %d bytes, uploaded uuid=%s", len(ct), uuid)

	// RECIPIENT: disclose the email credential -> JWT -> USK -> unseal.
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

	dl, err := cryptifyDownload(cryptifyURL, uuid)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	vk, err := pkgPublicKey(pkgURL + "/v2/sign/parameters")
	if err != nil {
		t.Fatalf("vk: %v", err)
	}
	usk, err := pkgFetchUSK(pkgURL, jwt, ts)
	if err != nil {
		t.Fatalf("usk: %v", err)
	}
	unsealRes, err := runOracle(map[string]any{
		"op":            "unseal",
		"ciphertextB64": base64.StdEncoding.EncodeToString(dl),
		"vk":            vk,
		"recipientId":   recipientEmail,
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
	t.Logf("decrypted OK (%d bytes) after disclosing a real email credential", len(got))
}
