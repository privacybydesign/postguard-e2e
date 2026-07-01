package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/privacybydesign/irmago/irma"
)

// This file holds the small requestor-side HTTP helpers the integration test
// needs: issuing a credential to the holder via the irma-server, and starting
// a PKG-initiated disclosure + polling the PKG for the resulting JWT. The
// holder side is the YiviDriver; these are the counterparties.

// conItem mirrors PostGuard's pg_core::api ConItem (Single variant): a single
// disclosure attribute. That's all we need for the studentCard test.
type conItem struct {
	T        string `json:"t"`
	V        string `json:"v,omitempty"`
	Optional bool   `json:"optional,omitempty"`
}

// irmaAuthRequest mirrors pg_core::api::IrmaAuthRequest — the body the PKG's
// /v2/{irma,request}/start endpoint accepts.
type irmaAuthRequest struct {
	Con      []conItem `json:"con"`
	Validity uint64    `json:"validity,omitempty"`
}

// sessionPackage is the subset of the irma-server / PKG session-start response
// we care about: the QR/session pointer and the requestor token.
type sessionPackage struct {
	SessionPtr *irma.Qr `json:"sessionPtr"`
	Token      string   `json:"token"`
}

// issueViaServer acts as an issuance requestor against a --no-auth irma-server,
// returning the session pointer the holder should run to receive the credential.
func issueViaServer(serverURL string, req *irma.IssuanceRequest) (*irma.Qr, error) {
	return postSession(serverURL+"/session", req)
}

// pkgStartDisclosure asks the PKG to start a disclosure session for con and
// returns the session pointer plus the requestor token used to fetch the JWT.
func pkgStartDisclosure(pkgURL string, con irmaAuthRequest) (*irma.Qr, string, error) {
	body, err := json.Marshal(con)
	if err != nil {
		return nil, "", err
	}
	resp, err := http.Post(pkgURL+"/v2/irma/start", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("PKG /start returned %d: %s", resp.StatusCode, string(raw))
	}
	var pkg sessionPackage
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return nil, "", fmt.Errorf("decode session package: %w (body: %s)", err, string(raw))
	}
	if pkg.SessionPtr == nil {
		return nil, "", fmt.Errorf("PKG /start returned no sessionPtr (body: %s)", string(raw))
	}
	return pkg.SessionPtr, pkg.Token, nil
}

// pkgPollJWT polls the PKG's JWT endpoint until the session result JWT is
// available (the PKG proxies the irma-server's result-jwt).
func pkgPollJWT(pkgURL, token string) (string, error) {
	deadline := time.Now().Add(15 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("%s/v2/irma/jwt/%s", pkgURL, token))
		if err != nil {
			return "", err
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		last = string(body)
		// A JWS has three dot-separated segments; the "not ready yet" responses don't.
		if resp.StatusCode == http.StatusOK && len(bytes.Split(body, []byte("."))) == 3 {
			return last, nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return "", fmt.Errorf("JWT not ready within deadline (last response: %q)", last)
}

func postSession(url string, req any) (*irma.Qr, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("POST %s returned %d: %s", url, resp.StatusCode, string(raw))
	}
	var pkg sessionPackage
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return nil, fmt.Errorf("decode session package: %w (body: %s)", err, string(raw))
	}
	if pkg.SessionPtr == nil {
		return nil, fmt.Errorf("no sessionPtr in response (body: %s)", string(raw))
	}
	return pkg.SessionPtr, nil
}
