package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/privacybydesign/irmago/irma"
)

// TestKeyshareDisclosureFlow is the keyshare-backed variant of the disclosure
// flow (postguard#238). The flows beside it use `irma-demo.*`, which is not
// keyshare-backed: the holder owns its whole secret key and computes its proofs
// alone. Production Yivi traffic is the other case — the secret key is split
// with a keyshare server, and every proof costs a PIN-authenticated round trip
// to it — so the proof computation PostGuard actually runs against had no
// coverage here. This walks that leg.
//
// It uses the keyshare-backed `test` scheme irmago bundles, against an
// in-process irma-server and keyshare server, so it needs no docker stack and
// no PKG — only an irmago checkout for the schemes and keys (IRMAGO_ROOT).
// The stack-based `irma-demo` flows are unchanged and still the ones that cover
// PostGuard's own endpoints end to end.
//
//	go test -run TestKeyshareDisclosureFlow -v
func TestKeyshareDisclosureFlow(t *testing.T) {
	const (
		credType = "test.test.email"
		attrType = "test.test.email.email"
		attrVal  = "keyshare-holder@golden.test"
	)
	scheme := irma.NewSchemeManagerIdentifier("test")

	// Just over the holder's token leeway: long enough that enrollment accepts
	// the token it is handed (it rejects one expiring inside the leeway), short
	// enough that a second or two of waiting makes the next session buy a fresh
	// one with the PIN. The margin against enrollment is ~5s for an in-process
	// round trip that takes milliseconds.
	const keysharePinExpiry = keyshareTokenLeeway + 5*time.Second

	testdata := irmagoTestdata()
	schemesAssets := filepath.Join(testdata, "irma_configuration")
	if _, err := os.Stat(filepath.Join(schemesAssets, "test", "description.xml")); err != nil {
		t.Skipf("irmago testdata not found at %s — set IRMAGO_ROOT to an irmago checkout", testdata)
	}

	logger := quietLogger()
	work := t.TempDir()

	ks, err := startLocalKeyshareServer(scheme, testdata, keysharePinExpiry, logger)
	if err != nil {
		t.Fatalf("start keyshare server: %v", err)
	}
	defer ks.Stop()
	t.Logf("keyshare server up on %s", ks.URL)

	srv, err := startLocalIrmaServer("localhost:0", schemesAssets, filepath.Join(testdata, "privatekeys"), work, logger)
	if err != nil {
		t.Fatalf("start irma-server: %v", err)
	}
	defer srv.Stop()
	t.Logf("irma-server up on %s", srv.URL)

	d, err := NewYiviDriver(filepath.Join(work, "client"), schemesAssets, filepath.Join(work, "eudi"))
	if err != nil {
		t.Fatalf("build holder: %v", err)
	}
	defer d.Close()

	// 1) Enroll: the keyshare server takes over half the holder's secret key for
	//    this scheme and issues it the scheme's keyshare credential. This is the
	//    first PIN authentication.
	enrolled := time.Now()
	if err := d.KeyshareEnroll(scheme, keysharePin); err != nil {
		t.Fatalf("keyshare enrollment: %v", err)
	}
	if ks.PinAuthRequests() == 0 {
		t.Fatalf("enrollment made no PIN-authentication calls to the keyshare server")
	}
	t.Logf("holder enrolled with the keyshare server of scheme %s", scheme)

	// 2) Issuance of a keyshare-backed credential. The holder cannot build its
	//    commitments on its own, so it already has to involve the keyshare
	//    server — riding the authentication enrollment just bought, with no
	//    fresh PIN.
	issQR, _, _, err := srv.StartSession(irma.NewIssuanceRequest([]*irma.CredentialRequest{{
		CredentialTypeID: irma.NewCredentialTypeIdentifier(credType),
		Attributes:       map[string]string{"email": attrVal},
	}}), nil, "")
	if err != nil {
		t.Fatalf("start issuance: %v", err)
	}
	if err := d.RunSession(issQR); err != nil {
		t.Fatalf("keyshare-backed issuance: %v", err)
	}
	t.Logf("issued %s to the holder", credType)

	// 3) Wait out the enrollment token, then disclose. This is the proof the
	//    production client computes — the holder's response combined with the
	//    keyshare server's — and by now the holder has to buy a fresh
	//    authentication with the PIN first, which is the branch the driver's PIN
	//    handling exists for. The issuance above took the other branch.
	stale := keysharePinExpiry - keyshareTokenLeeway + time.Second
	time.Sleep(time.Until(enrolled.Add(stale)))

	pinsBefore, proofsBefore := d.PinRequests(), ks.ProofRequests()
	discQR, token, _, err := srv.StartSession(
		irma.NewDisclosureRequest(irma.NewAttributeTypeIdentifier(attrType)), nil, "")
	if err != nil {
		t.Fatalf("start disclosure: %v", err)
	}
	if err := d.RunSession(discQR); err != nil {
		t.Fatalf("keyshare-backed disclosure: %v", err)
	}

	// 4) The server must accept the proof, and it must carry the attribute we
	//    issued — a VALID status over an empty disclosure would prove nothing.
	res, err := srv.GetSessionResult(token)
	if err != nil {
		t.Fatalf("get session result: %v", err)
	}
	if res.ProofStatus != irma.ProofStatusValid {
		t.Fatalf("expected proof status VALID, got %v", res.ProofStatus)
	}
	found := false
	for _, con := range res.Disclosed {
		for _, a := range con {
			if a.Identifier.String() == attrType && a.RawValue != nil && *a.RawValue == attrVal {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("disclosure did not carry %s=%q; got %+v", attrType, attrVal, res.Disclosed)
	}

	// 5) The point of the whole test. Everything above would also pass over a
	//    credential the holder can prove on its own, which is what the irma-demo
	//    flows already cover — so assert the disclosure could not have been
	//    computed without the keyshare server, and that it cost a PIN.
	if proofs := ks.ProofRequests() - proofsBefore; proofs == 0 {
		t.Errorf("disclosure made no proof calls to the keyshare server, so it computed its proof alone")
	}
	if pins := d.PinRequests() - pinsBefore; pins == 0 {
		t.Errorf("disclosure answered no PIN prompt: the enrollment token %s ago should have gone stale after %s",
			time.Since(enrolled), stale)
	}
	t.Logf("keyshare-backed disclosure VALID: %d proof call(s) to the keyshare server, %d PIN prompt(s) answered",
		ks.ProofRequests(), d.PinRequests())
}
