package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
)

// mailcrabHasMessageTo reports whether mailcrab captured a message addressed to
// `to`. mailcrab's message JSON shape varies by version, so we just check the
// recipient address appears in the /api/messages payload.
func mailcrabHasMessageTo(baseURL, to string) (bool, error) {
	resp, err := http.Get(baseURL + "/api/messages")
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("mailcrab /api/messages -> %d: %s", resp.StatusCode, string(raw))
	}
	return strings.Contains(string(raw), to), nil
}
