package main

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/privacybydesign/irmago/irma"
)

// TestPKGInitiatedDisclosureYieldsJWT is the full acceptance test for EPIC
// issue #204: the headless holder completes a PKG-initiated disclosure against
// the dev irma-server and the PKG yields a valid JWT — no phone involved.
//
// It requires the e2e stack (stack/docker-compose.yml: PKG + irma-server) to be
// running; it skips otherwise so `go test ./...` stays green without the stack.
//
//	cd ../stack && docker compose up -d
//	go test -run TestPKGInitiatedDisclosureYieldsJWT -v
func TestPKGInitiatedDisclosureYieldsJWT(t *testing.T) {
	pkgURL := env("PG_PKG_URL", "http://localhost:8087")
	irmaURL := env("PG_IRMA_URL", "http://localhost:8088")
	schemesAssets := schemeRoot()

	if !reachable(pkgURL + "/health") {
		t.Skipf("PKG not reachable at %s — start the e2e stack (cd ../stack && docker compose up -d)", pkgURL)
	}

	work := t.TempDir()
	d, err := NewYiviDriver(filepath.Join(work, "client"), schemesAssets, filepath.Join(work, "eudi"))
	if err != nil {
		t.Fatalf("build holder: %v", err)
	}
	defer d.Close()

	// 1) Issue a credential to the holder via the irma-server (test as requestor).
	iss := irma.NewIssuanceRequest([]*irma.CredentialRequest{{
		CredentialTypeID: irma.NewCredentialTypeIdentifier("irma-demo.RU.studentCard"),
		Attributes: map[string]string{
			"university":        "Radboud University",
			"studentCardNumber": "0812345673",
			"studentID":         "s1234567",
			"level":             "PhD",
		},
	}})
	issQR, err := issueViaServer(irmaURL, iss)
	if err != nil {
		t.Fatalf("start issuance: %v", err)
	}
	if err := d.RunSession(issQR); err != nil {
		t.Fatalf("holder issuance: %v", err)
	}
	t.Log("holder now holds irma-demo.RU.studentCard")

	// 2) PKG starts a disclosure session for one of the held attributes.
	sp, token, err := pkgStartDisclosure(pkgURL, irmaAuthRequest{
		Con:      []conItem{{T: "irma-demo.RU.studentCard.level"}},
		Validity: 300,
	})
	if err != nil {
		t.Fatalf("PKG start disclosure: %v", err)
	}
	t.Logf("PKG started disclosure session (token %s)", token)

	// 3) Headless holder completes the PKG-initiated disclosure.
	if err := d.RunSession(sp); err != nil {
		t.Fatalf("holder disclosure: %v", err)
	}

	// 4) The PKG yields a signed JWT for the completed session.
	jwt, err := pkgPollJWT(pkgURL, token)
	if err != nil {
		t.Fatalf("poll PKG JWT: %v", err)
	}
	if segs := strings.Split(jwt, "."); len(segs) != 3 {
		t.Fatalf("expected a 3-segment JWS, got %d segments: %.80s", len(segs), jwt)
	}
	t.Logf("PKG returned a valid JWT (%d bytes) — headless disclosure -> JWT proven", len(jwt))
}

func reachable(url string) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}
