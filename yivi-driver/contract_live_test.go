package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

// TestLiveContract is the L1 contract check, live half (EPIC issue #212).
// It closes the loop the other artifacts leave open:
//
//   - pg-pkg/tests/contract_examples.rs pins examples ↔ parser
//   - contracts/validate-examples.mjs pins examples ↔ JSON Schema
//   - THIS test pins spec ↔ examples ↔ RUNNING SERVER: the OpenAPI document
//     must be internally valid, its request schemas must agree with the
//     canonical examples, and the live PKG's responses must match what the
//     spec promises.
//
// Requires the stack (skips otherwise) and the sibling postguard checkout
// (override with POSTGUARD_ROOT).
func TestLiveContract(t *testing.T) {
	pkgURL := env("PG_PKG_URL", "http://localhost:8087")
	pgRoot := env("POSTGUARD_ROOT", "../../postguard")
	if !reachable(pkgURL + "/health") {
		t.Skipf("PKG not reachable at %s — cd ../stack && docker compose up -d", pkgURL)
	}

	// Load and validate the spec itself.
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile(filepath.Join(pgRoot, "pg-pkg", "api-description.yaml"))
	if err != nil {
		t.Fatalf("load OpenAPI: %v", err)
	}
	if err := doc.Validate(loader.Context); err != nil {
		t.Fatalf("the OpenAPI document is not internally valid: %v", err)
	}
	// Route matching is server-URL-aware; point the spec at the stack.
	doc.Servers = openapi3.Servers{{URL: pkgURL}}
	router, err := gorillamux.NewRouter(doc)
	if err != nil {
		t.Fatalf("router: %v", err)
	}

	// The public parameter endpoints: live responses must match the spec.
	for _, path := range []string{"/v2/parameters", "/v2/sign/parameters"} {
		req, _ := http.NewRequest(http.MethodGet, pkgURL+path, nil)
		resp, body := do(t, req)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s -> %d: %s", path, resp.StatusCode, body)
		}
		validateResponse(t, router, req, resp, body)
	}

	// The canonical examples against BOTH the spec's request schema and the
	// live server.
	//
	// Valid examples use PRODUCTION pbdf attribute types (they document real
	// requests), which the test irma-server deliberately does not know — so
	// the PKG-side contract here is "the body PARSES" (anything but 400). A
	// pbdf-unaware upstream turns those into 500 "couldn't create session",
	// which is out of the PKG's parse contract. The full 200 + response-shape
	// path is exercised below with a test-scheme request.
	for _, name := range exampleFiles(t, pgRoot, "valid") {
		payload := readExample(t, pgRoot, "valid", name)

		req := startRequest(t, pkgURL, payload)
		if err := validateRequest(router, req, payload); err != nil {
			t.Errorf("valid/%s: the OpenAPI request schema rejects a canonical valid example: %v", name, err)
		}

		resp, body := postStartPaced(t, pkgURL, payload)
		switch resp.StatusCode {
		case http.StatusBadRequest:
			t.Errorf("valid/%s: live PKG rejected a canonical valid example with 400: %s", name, body)
		case http.StatusOK:
			validateResponse(t, router, req, resp, body)
			t.Logf("ok valid/%s: spec-accepted, live 200, response matches spec", name)
		default:
			// Parsed fine; upstream scheme knowledge is not this contract.
			t.Logf("ok valid/%s: spec-accepted, live parse accepted (%d from upstream)", name, resp.StatusCode)
		}
	}

	// Full happy path with a test-scheme identity the stack's irma-server
	// KNOWS: 200 and a SessionData response matching the spec.
	{
		payload := []byte(`{ "con": [ { "t": "irma-demo.RU.studentCard.level" } ], "validity": 60 }`)
		req := startRequest(t, pkgURL, payload)
		resp, body := postStartPaced(t, pkgURL, payload)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("test-scheme start: got %d, want 200: %s", resp.StatusCode, body)
		}
		validateResponse(t, router, req, resp, body)
		t.Logf("ok test-scheme start: live 200, SessionData matches spec")
	}

	for _, name := range exampleFiles(t, pgRoot, "invalid") {
		payload := readExample(t, pgRoot, "invalid", name)

		req := startRequest(t, pkgURL, payload)
		if err := validateRequest(router, req, payload); err == nil {
			t.Errorf("invalid/%s: the OpenAPI request schema ACCEPTS a canonical invalid example (spec laxer than the parser)", name)
		}

		resp, body := postStartPaced(t, pkgURL, payload)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("invalid/%s: live PKG returned %d, want 400: %s", name, resp.StatusCode, body)
			continue
		}
		var envelope struct {
			Error   *bool  `json:"error"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error == nil || !*envelope.Error || envelope.Message == "" {
			t.Errorf("invalid/%s: 400 body is not the documented {error, message} envelope: %s", name, body)
			continue
		}
		t.Logf("ok invalid/%s: spec-rejected, live 400 (%s)", name, envelope.Message)
	}
}

func exampleFiles(t *testing.T, pgRoot, kind string) []string {
	dir := filepath.Join(pgRoot, "pg-pkg", "schemas", "examples", kind)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatalf("no %s examples in %s — an empty contract is a failing contract", kind, dir)
	}
	return names
}

func readExample(t *testing.T, pgRoot, kind, name string) []byte {
	b, err := os.ReadFile(filepath.Join(pgRoot, "pg-pkg", "schemas", "examples", kind, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func startRequest(t *testing.T, pkgURL string, payload []byte) *http.Request {
	req, err := http.NewRequest(http.MethodPost, pkgURL+"/v2/request/start", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	return req
}

// validateRequest checks the payload against the spec's request schema for
// POST /v2/request/start.
func validateRequest(router routers.Router, req *http.Request, payload []byte) error {
	route, pathParams, err := router.FindRoute(req)
	if err != nil {
		return err
	}
	clone := req.Clone(context.Background())
	clone.Body = io.NopCloser(bytes.NewReader(payload))
	return openapi3filter.ValidateRequest(context.Background(), &openapi3filter.RequestValidationInput{
		Request:    clone,
		PathParams: pathParams,
		Route:      route,
	})
}

// validateResponse checks a live response against the spec.
func validateResponse(t *testing.T, router routers.Router, req *http.Request, resp *http.Response, body []byte) {
	t.Helper()
	route, pathParams, err := router.FindRoute(req)
	if err != nil {
		t.Fatalf("%s %s: no route in spec: %v", req.Method, req.URL.Path, err)
	}
	input := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{
			Request:    req,
			PathParams: pathParams,
			Route:      route,
		},
		Status: resp.StatusCode,
		Header: resp.Header,
	}
	input.SetBodyBytes(body)
	if err := openapi3filter.ValidateResponse(context.Background(), input); err != nil {
		t.Errorf("%s %s: live response does not match the spec: %v", req.Method, req.URL.Path, err)
	}
}

// postStartPaced posts to /v2/request/start, retrying on 429: the endpoint is
// sensitive-rate-limited (2/s, burst 10) and this test fires a dozen posts.
func postStartPaced(t *testing.T, pkgURL string, payload []byte) (*http.Response, []byte) {
	t.Helper()
	for attempt := 0; ; attempt++ {
		resp, body := do(t, startRequest(t, pkgURL, payload))
		if resp.StatusCode != http.StatusTooManyRequests {
			return resp, body
		}
		if attempt >= 10 {
			t.Fatalf("still rate-limited after %d attempts", attempt)
		}
		time.Sleep(700 * time.Millisecond)
	}
}

func do(t *testing.T, req *http.Request) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}
