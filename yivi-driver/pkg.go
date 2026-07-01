package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// PKG key-material helpers used by the golden-flow test. The publicKey / key /
// signing-key values are opaque (pg-core-serialized) — we carry them as raw
// JSON and hand them straight to the pg-wasm oracle.

func httpGetJSON(url, bearer string, out any) error {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s -> %d: %s", url, resp.StatusCode, string(raw))
	}
	return json.Unmarshal(raw, out)
}

// pkgPublicKey fetches `.publicKey` from /v2/parameters (MPK) or
// /v2/sign/parameters (verification key).
func pkgPublicKey(url string) (json.RawMessage, error) {
	var r struct {
		PublicKey json.RawMessage `json:"publicKey"`
	}
	if err := httpGetJSON(url, "", &r); err != nil {
		return nil, err
	}
	if len(r.PublicKey) == 0 {
		return nil, fmt.Errorf("no publicKey in %s", url)
	}
	return r.PublicKey, nil
}

// pkgFetchUSK gets the IBE user secret key for timestamp ts (Bearer JWT from a
// completed disclosure). The ts must equal the seal timestamp.
func pkgFetchUSK(pkgURL, jwt string, ts int64) (json.RawMessage, error) {
	var r struct {
		Key json.RawMessage `json:"key"`
	}
	url := fmt.Sprintf("%s/v2/irma/key/%d", pkgURL, ts)
	if err := httpGetJSON(url, jwt, &r); err != nil {
		return nil, err
	}
	if len(r.Key) == 0 {
		return nil, fmt.Errorf("no key in USK response from %s", url)
	}
	return r.Key, nil
}

// pkgFetchSigningKey gets IBS signing keys. `bearer` is the Authorization
// token — either a Yivi disclosure JWT or a `PG-` business API key (the API-key
// path is what the golden flow uses; the PKG then fills the signing identity
// from the business DB and ignores pubSignID). pubSignID is the sender's public
// signing identity, used only on the JWT path.
func pkgFetchSigningKey(pkgURL, bearer string, pubSignID []conItem) (pub, priv json.RawMessage, err error) {
	body, _ := json.Marshal(map[string]any{"pubSignId": pubSignID})
	req, _ := http.NewRequest(http.MethodPost, pkgURL+"/v2/irma/sign/key", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearer)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("POST /v2/irma/sign/key -> %d: %s", resp.StatusCode, string(raw))
	}
	var r struct {
		PubSignKey  json.RawMessage `json:"pubSignKey"`
		PrivSignKey json.RawMessage `json:"privSignKey"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, nil, fmt.Errorf("decode sign/key: %w (body: %s)", err, string(raw))
	}
	if len(r.PubSignKey) == 0 {
		return nil, nil, fmt.Errorf("no pubSignKey (body: %s)", string(raw))
	}
	return r.PubSignKey, r.PrivSignKey, nil
}
