package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/privacybydesign/irmago/irma"
)

// TestGenerateCryptoFixtures writes the crypto-compat fixtures (EPIC issue
// #206) — self-contained sets of {ciphertext, verifying key, USK, meta} sealed
// by the PINNED published @e4a/pg-wasm, in both wire formats (streaming and
// in-memory). The committed fixtures are then verified forever, stack-free, by
// fixtures/verify.mjs (published pg-wasm) and fixtures-verify/ (current
// working-tree pg-core): if either can no longer unseal them, wire-format
// compatibility broke and old ciphertexts in the wild would too.
//
// Generation is a rare, deliberate act (new pg-wasm major, new format
// version). It needs the stack up and is gated:
//
//	cd ../stack && PG_API_KEY=… docker compose up -d
//	PG_GENERATE_FIXTURES=1 PG_API_KEY=… go test -run TestGenerateCryptoFixtures -v
func TestGenerateCryptoFixtures(t *testing.T) {
	if os.Getenv("PG_GENERATE_FIXTURES") == "" {
		t.Skip("set PG_GENERATE_FIXTURES=1 to (re)generate the committed crypto fixtures")
	}
	pkgURL := env("PG_PKG_URL", "http://localhost:8087")
	irmaURL := env("PG_IRMA_URL", "http://localhost:8088")
	schemesAssets := schemeRoot()
	apiKey := os.Getenv("PG_API_KEY")
	if apiKey == "" {
		t.Fatal("PG_API_KEY must be set (the seeded business API key) to fetch the signing key")
	}
	if !reachable(pkgURL + "/health") {
		t.Fatalf("PKG not reachable at %s — start the e2e stack first", pkgURL)
	}

	const (
		attrType    = "irma-demo.RU.studentCard.level"
		attrVal     = "PhD"
		recipientID = "phd-holder"
	)
	ts := time.Now().Unix()
	plaintext := []byte("postguard-e2e crypto-compat fixture: old ciphertexts must decrypt forever")

	wasmVersion := pgWasmVersion(t)
	outDir := filepath.Join("..", "fixtures", "pg-wasm-"+wasmVersion)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Key material: full PKG responses, committed verbatim so verifiers can
	// parse them the same way real clients do.
	mpkRaw := httpGetRaw(t, pkgURL+"/v2/parameters", "")
	vkRaw := httpGetRaw(t, pkgURL+"/v2/sign/parameters", "")

	// Holder discloses the fixture identity to mint the USK for this ts.
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
	sp, token, err := pkgStartDisclosure(pkgURL, irmaAuthRequest{Con: []conItem{{T: attrType}}, Validity: 300})
	if err != nil {
		t.Fatalf("pkg start: %v", err)
	}
	if err := d.RunSession(sp); err != nil {
		t.Fatalf("disclose: %v", err)
	}
	jwt, err := pkgPollJWT(pkgURL, token)
	if err != nil {
		t.Fatalf("poll jwt: %v", err)
	}
	uskRaw := httpGetRaw(t, fmt.Sprintf("%s/v2/irma/key/%d", pkgURL, ts), jwt)

	// Signing key via the business API key (fills the pbdf sender email).
	pub, priv, err := pkgFetchSigningKey(pkgURL, apiKey, []conItem{})
	if err != nil {
		t.Fatalf("signing key: %v", err)
	}

	mpk := jsonField(t, mpkRaw, "publicKey")
	vk := jsonField(t, vkRaw, "publicKey")
	usk := jsonField(t, uskRaw, "key")

	// Seal in both wire formats.
	sealJob := func(op string) []byte {
		res, err := runOracle(map[string]any{
			"op":  op,
			"mpk": mpk,
			"policy": map[string]any{
				recipientID: map[string]any{"ts": ts, "con": []conItem{{T: attrType, V: attrVal}}},
			},
			"pubSignKey":   pub,
			"privSignKey":  priv,
			"plaintextB64": base64.StdEncoding.EncodeToString(plaintext),
		})
		if err != nil {
			t.Fatalf("%s: %v", op, err)
		}
		var b64 string
		if err := json.Unmarshal(res["ciphertextB64"], &b64); err != nil {
			t.Fatalf("%s result: %v", op, err)
		}
		ct, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			t.Fatalf("%s decode: %v", op, err)
		}
		return ct
	}
	stream := sealJob("seal")
	mem := sealJob("sealMem")

	// Self-check both before committing anything: unseal must round-trip.
	for _, c := range []struct {
		op, name string
		ct       []byte
	}{
		{"unseal", "stream", stream},
		{"unsealMem", "mem", mem},
	} {
		res, err := runOracle(map[string]any{
			"op":            c.op,
			"ciphertextB64": base64.StdEncoding.EncodeToString(c.ct),
			"vk":            vk,
			"recipientId":   recipientID,
			"usk":           usk,
		})
		if err != nil {
			t.Fatalf("self-check %s: %v", c.name, err)
		}
		var ptB64 string
		_ = json.Unmarshal(res["plaintextB64"], &ptB64)
		if got, _ := base64.StdEncoding.DecodeString(ptB64); string(got) != string(plaintext) {
			t.Fatalf("self-check %s: plaintext mismatch", c.name)
		}
	}

	meta := map[string]any{
		"sealedBy":     "@e4a/pg-wasm@" + wasmVersion,
		"generatedAt":  time.Now().UTC().Format(time.RFC3339),
		"recipientId":  recipientID,
		"con":          []conItem{{T: attrType, V: attrVal}},
		"ts":           ts,
		"plaintextB64": base64.StdEncoding.EncodeToString(plaintext),
		"senderEmail":  "sender@golden.test",
		"files": map[string]string{
			"stream.bin": "streaming container (sealStream / cryptify / pg-js upload)",
			"mem.bin":    "in-memory container (seal / pg-js toBytes)",
		},
	}
	metaJSON, _ := json.MarshalIndent(meta, "", "  ")

	writes := map[string][]byte{
		"meta.json":  metaJSON,
		"mpk.json":   mpkRaw,
		"vk.json":    vkRaw,
		"usk.json":   uskRaw,
		"stream.bin": stream,
		"mem.bin":    mem,
	}
	for name, data := range writes {
		if err := os.WriteFile(filepath.Join(outDir, name), data, 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	t.Logf("fixtures written to %s (stream %dB, mem %dB) — commit them", outDir, len(stream), len(mem))
}

// pgWasmVersion reads the pinned @e4a/pg-wasm version from the oracle's
// package.json dependency (exact pin, no range).
func pgWasmVersion(t *testing.T) string {
	raw, err := os.ReadFile(filepath.Join("oracle", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	v := pkg.Dependencies["@e4a/pg-wasm"]
	if v == "" {
		t.Fatal("no @e4a/pg-wasm dependency in oracle/package.json")
	}
	return v
}

func httpGetRaw(t *testing.T, url, bearer string) []byte {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s -> %d: %s", url, resp.StatusCode, string(raw))
	}
	return raw
}

func jsonField(t *testing.T, raw []byte, field string) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse json: %v", err)
	}
	v, ok := m[field]
	if !ok || len(v) == 0 {
		t.Fatalf("field %q missing in %s", field, string(raw))
	}
	return v
}
