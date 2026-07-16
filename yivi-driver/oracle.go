package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
)

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
