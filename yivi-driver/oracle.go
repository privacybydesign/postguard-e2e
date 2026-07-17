package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// schemeRoot is the irma_configuration directory (containing irma-demo/) used
// by both the containerized irma-server and the headless holder. It is the
// pinned, real irma-demo scheme provisioned by stack/schemes/provision.sh —
// NOT irmago's bundled testdata, which lacks sidn-pbdf.email. Override with
// IRMA_SCHEME_ROOT.
func schemeRoot() string {
	if v := os.Getenv("IRMA_SCHEME_ROOT"); v != "" {
		return v
	}
	return filepath.Join("..", "stack", "schemes", "irma_configuration")
}

// emailAttribute is the attribute type the stack signs sender identities with.
// The stack can only issue irma-demo credentials, so it uses the demo type
// (postguard#236); this must match PKG_EMAIL_ATTRIBUTE / ROCKET_EMAIL_ATTRIBUTE
// in docker-compose.yml. Override with IRMA_EMAIL_ATTRIBUTE.
func emailAttribute() string {
	if v := os.Getenv("IRMA_EMAIL_ATTRIBUTE"); v != "" {
		return v
	}
	return "irma-demo.sidn-pbdf.email.email"
}

// runOracle shells out to the Node pg-wasm crypto oracle (oracle/oracle.mjs),
// passing `job` as JSON on stdin and returning the parsed JSON result. The Go
// test owns all network + Yivi; the oracle is pure seal/unseal.
func runOracle(job any) (map[string]json.RawMessage, error) {
	in, err := json.Marshal(job)
	if err != nil {
		return nil, err
	}
	// --experimental-wasm-modules: importing the .wasm ESM is unflagged on
	// recent Node but still gated on some CI Node versions; the flag is accepted
	// across 22–26, so pass it for portability.
	cmd := exec.Command("node", "--no-warnings", "--experimental-wasm-modules", "oracle/oracle.mjs")
	cmd.Stdin = bytes.NewReader(in)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	runErr := cmd.Run()

	var res map[string]json.RawMessage
	if jerr := json.Unmarshal(out.Bytes(), &res); jerr != nil {
		return nil, fmt.Errorf("oracle produced no JSON (runErr=%v)\nstderr: %s\nstdout: %s", runErr, errb.String(), out.String())
	}
	var ok bool
	_ = json.Unmarshal(res["ok"], &ok)
	if !ok {
		var msg string
		_ = json.Unmarshal(res["error"], &msg)
		return nil, fmt.Errorf("oracle error: %s", msg)
	}
	return res, nil
}
