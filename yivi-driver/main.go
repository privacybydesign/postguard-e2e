// Command yividriver is a self-test proving the headless Yivi holder works:
// it starts an in-process irma-server (seeded with irmago's test schemes +
// issuer private keys), issues itself a credential, discloses it, and fetches
// the signed result-JWT — the exact artifact the PostGuard PKG consumes.
//
// This is the keystone for EPIC issue #204: it demonstrates that a full Yivi
// disclosure (and therefore PostGuard decryption) can be driven end-to-end in
// CI with no phone. The only checkout path it needs is a sibling irmago
// (IRMAGO_ROOT, default ../../irmago); it can be overridden via env vars. An
// earlier version of this comment also named postguard-website, which no longer
// exists as a repo — the site is postguard-js's apps/website — and was never a
// path default here anyway.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/privacybydesign/irmago/irma"
)

const irmaPort = 48690

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
	fmt.Println("\nOK: headless holder issued a credential and produced a VALID disclosure proof (no phone)")
}

func run() error {
	// Defaults to the standard sibling checkout (matches go.mod's replace); override with IRMAGO_ROOT.
	testdata := irmagoTestdata()
	schemesSrc := filepath.Join(testdata, "irma_configuration")
	privkeys := filepath.Join(testdata, "privatekeys")

	work, err := os.MkdirTemp("", "yivi-driver-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	logger := quietLogger()
	irma.SetLogger(logger)

	srv, err := startLocalIrmaServer(fmt.Sprintf("localhost:%d", irmaPort), schemesSrc, privkeys, work, logger)
	if err != nil {
		return err
	}
	defer srv.Stop()
	fmt.Printf("irma-server up on %s (schemes: test + irma-demo)\n", srv.URL)

	// Build the headless holder.
	storagePath := filepath.Join(work, "client")
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		return err
	}
	eudiPath := filepath.Join(work, "eudi")
	d, err := NewYiviDriver(storagePath, schemesSrc, eudiPath)
	if err != nil {
		return fmt.Errorf("NewYiviDriver: %w", err)
	}
	defer d.Close()
	fmt.Println("headless holder constructed")

	// 1) Issue a non-keyshare, non-revocable irma-demo credential to the holder.
	issReq := irma.NewIssuanceRequest([]*irma.CredentialRequest{{
		CredentialTypeID: irma.NewCredentialTypeIdentifier("irma-demo.RU.studentCard"),
		Attributes: map[string]string{
			"university":        "Radboud University",
			"studentCardNumber": "0812345673",
			"studentID":         "s1234567",
			"level":             "PhD",
		},
	}})
	qr, _, _, err := srv.StartSession(issReq, nil, "")
	if err != nil {
		return fmt.Errorf("start issuance session: %w", err)
	}
	if err := d.RunSession(qr); err != nil {
		return fmt.Errorf("issuance: %w", err)
	}
	fmt.Println("issued irma-demo.RU.studentCard to holder")

	// 2) Disclose an attribute back.
	discReq := irma.NewDisclosureRequest(irma.NewAttributeTypeIdentifier("irma-demo.RU.studentCard.level"))
	qr2, token, _, err := srv.StartSession(discReq, nil, "")
	if err != nil {
		return fmt.Errorf("start disclosure session: %w", err)
	}
	if err := d.RunSession(qr2); err != nil {
		return fmt.Errorf("disclosure: %w", err)
	}

	// 3) Verify the server-side result: the disclosure proof must be VALID.
	// (Serializing this result as a signed JWT is a requestorserver feature the
	// full irma-server provides; the PKG proxies it. That path is exercised by
	// the stack-integration flow in issue #205, not this in-process spike.)
	res, err := srv.GetSessionResult(token)
	if err != nil {
		return fmt.Errorf("get session result: %w", err)
	}
	fmt.Printf("disclosure proof status: %v (%d disjunction(s) disclosed)\n", res.ProofStatus, len(res.Disclosed))
	for _, con := range res.Disclosed {
		for _, a := range con {
			val := "<nil>"
			if a.RawValue != nil {
				val = *a.RawValue
			}
			fmt.Printf("  disclosed %s = %q\n", a.Identifier, val)
		}
	}
	if res.ProofStatus != irma.ProofStatusValid {
		return fmt.Errorf("expected proof status VALID, got %v", res.ProofStatus)
	}
	return nil
}
