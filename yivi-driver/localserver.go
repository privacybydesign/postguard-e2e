package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/privacybydesign/irmago/irma/server"
	"github.com/privacybydesign/irmago/irma/server/irmaserver"
	"github.com/sirupsen/logrus"
)

// This file holds the in-process irma-server used by the flows that do not need
// the docker stack: the `go run .` self-test and the keyshare flow (which needs
// a server trusting the keyshare-backed `test` scheme, which the stack's
// irma-server does not serve). The stack-based flows talk to the containerised
// irma-server over HTTP instead.

// localIrmaServer is an in-process, --no-auth irma-server plus the HTTP server
// it is served on.
type localIrmaServer struct {
	*irmaserver.Server
	// URL is the address the holder gets pointed at, with the port that was
	// actually bound (so it is usable when addr asked for port 0).
	URL string

	http *http.Server
}

// startLocalIrmaServer boots an irma-server on addr, trusting the schemes in
// schemesAssets and issuing with the private keys in privkeysPath. Pass port 0
// in addr to let the OS pick a free one. scratch is a directory the caller
// owns; the schemes are copied into it because the server writes into its
// schemes path at startup, which would otherwise mutate schemesAssets.
func startLocalIrmaServer(addr, schemesAssets, privkeysPath, scratch string, logger *logrus.Logger) (*localIrmaServer, error) {
	schemesPath := filepath.Join(scratch, "irma_configuration")
	if err := copyDir(schemesAssets, schemesPath); err != nil {
		return nil, fmt.Errorf("copy schemes: %w", err)
	}

	// Bind before constructing the server: with port 0 the URL the server puts
	// in its session pointers is only knowable once the listener exists.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	url := "http://" + ln.Addr().String()

	srv, err := irmaserver.New(&server.Configuration{
		URL:                   url,
		SchemesPath:           schemesPath,
		IssuerPrivateKeysPath: privkeysPath,
		DisableSchemesUpdate:  true,
		Logger:                logger,
	})
	if err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("irmaserver.New: %w", err)
	}

	httpSrv := &http.Server{Handler: srv.HandlerFunc()}
	go func() { _ = httpSrv.Serve(ln) }()
	return &localIrmaServer{Server: srv, URL: url, http: httpSrv}, nil
}

// Stop shuts down the HTTP server and the irma-server behind it.
func (s *localIrmaServer) Stop() {
	_ = s.http.Close()
	s.Server.Stop()
}

// irmagoTestdata returns irmago's testdata directory: the schemes (incl. the
// keyshare-backed `test` scheme), issuer private keys and keyshare keys the
// in-process servers are seeded with. Override the checkout with IRMAGO_ROOT.
func irmagoTestdata() string {
	return filepath.Join(env("IRMAGO_ROOT", "../../irmago"), "testdata")
}

// copyDir recursively copies src to dst.
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

// quietLogger returns the logger the in-process servers run with. It does not
// touch irma.SetLogger: that global is shared with everything else in this
// package, so silencing it is the caller's decision to make and to undo.
func quietLogger() *logrus.Logger {
	logger := logrus.New()
	logger.SetLevel(logrus.FatalLevel)
	return logger
}
