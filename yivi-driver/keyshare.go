package main

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/privacybydesign/irmago/irma"
	"github.com/privacybydesign/irmago/irma/server"
	"github.com/privacybydesign/irmago/irma/server/keyshare/keyshareserver"
	"github.com/sirupsen/logrus"
)

// The keyshare server is the third counterparty in a production Yivi
// disclosure: the holder's secret key is split between the wallet and the
// keyshare server, so every proof over a keyshare-backed credential needs a
// PIN-authenticated round trip to it. irmago boots one for its own tests, but
// that helper lives in internal/testkeyshare, which the toolchain will not let
// another module import — so the handful of lines that matter are reproduced
// here on top of the public keyshareserver package. Same reason signer.go
// reimplements irmago's test signer.

const (
	// keysharePin is the PIN the headless holder enrolls with. Nothing about it
	// is secret; it is the value irmago's own keyshare tests use.
	keysharePin = "12345"

	// keyshareJwtKeyID selects which of the scheme's keyshare JWT keys to sign
	// with. irmago's testdata ships <scheme>-kss-sk-0.pem for every
	// keyshare-backed scheme, so 0 is the one that always exists.
	keyshareJwtKeyID = 0

	// keyshareTokenLeeway is the margin irmaclient's tokenValid subtracts before
	// deciding a PIN authentication has expired: a token good for less than
	// another minute counts as already gone, and the session re-authenticates.
	// It is not configurable from outside irmago, so a flow that wants to cover
	// re-authentication has to schedule around it.
	keyshareTokenLeeway = time.Minute
)

// keyshareProofPaths are the two endpoints a keyshare-backed proof cannot be
// computed without: the holder's commitments and its response are each combined
// with the keyshare server's half. Counting hits on them is how a flow shows it
// really co-computed a proof rather than merely talking to a keyshare server.
var keyshareProofPaths = map[string]bool{
	"/prove/getCommitments": true,
	"/prove/getResponse":    true,
}

// keysharePinPaths are the PIN-authentication endpoints: the holder proves it
// knows the PIN and gets back the token that authorises the proof calls above.
var keysharePinPaths = map[string]bool{
	"/users/verify_start":                 true,
	"/users/verify/pin":                   true,
	"/users/verify/pin_challengeresponse": true,
}

// localKeyshareServer is an in-process keyshare server backed by an in-memory
// user database, so it needs no SQL server of its own.
type localKeyshareServer struct {
	// URL is where it listens, which the scheme dictates (see below).
	URL string

	srv             *keyshareserver.Server
	http            *http.Server
	proofRequests   atomic.Int64
	pinAuthRequests atomic.Int64
}

// ProofRequests is how many proof co-computation calls (keyshareProofPaths) this
// server has served.
func (k *localKeyshareServer) ProofRequests() int { return int(k.proofRequests.Load()) }

// PinAuthRequests is how many PIN-authentication calls (keysharePinPaths) this
// server has served.
func (k *localKeyshareServer) PinAuthRequests() int { return int(k.pinAuthRequests.Load()) }

// startLocalKeyshareServer boots the keyshare server belonging to scheme,
// reading its keys from irmago's testdata (testdataPath). pinExpiry is how long
// a PIN authentication it hands out stays usable; it must exceed
// keyshareTokenLeeway, or the holder rejects its own token the moment it is
// issued and enrollment fails.
//
// The address is not ours to choose: the holder reads the keyshare server URL
// out of the scheme description it trusts, so the server has to appear at
// exactly the <KeyshareServer> that scheme names — http://localhost:8080 for
// irmago's bundled `test` scheme. A port clash therefore surfaces as a failure
// to start, not as a wrong address.
func startLocalKeyshareServer(scheme irma.SchemeManagerIdentifier, testdataPath string, pinExpiry time.Duration, logger *logrus.Logger) (*localKeyshareServer, error) {
	if pinExpiry <= keyshareTokenLeeway {
		return nil, fmt.Errorf("pin expiry %s must exceed the holder's %s token leeway, or enrollment rejects its own token", pinExpiry, keyshareTokenLeeway)
	}
	conf, err := irma.NewConfiguration(filepath.Join(testdataPath, "irma_configuration"), irma.ConfigurationOptions{})
	if err != nil {
		return nil, err
	}
	if err := conf.ParseFolder(); err != nil {
		return nil, err
	}
	sm, ok := conf.SchemeManagers[scheme]
	if !ok {
		return nil, fmt.Errorf("scheme %s not found under %s", scheme, testdataPath)
	}
	if sm.KeyshareServer == "" {
		return nil, fmt.Errorf("scheme %s is not keyshare-backed: its description declares no <KeyshareServer>", scheme)
	}
	ksURL, err := url.Parse(sm.KeyshareServer)
	if err != nil {
		return nil, fmt.Errorf("scheme %s declares an unparseable keyshare server %q: %w", scheme, sm.KeyshareServer, err)
	}

	srv, err := keyshareserver.New(&keyshareserver.Configuration{
		Configuration: &server.Configuration{
			IrmaConfiguration:     conf,
			IssuerPrivateKeysPath: filepath.Join(testdataPath, "privatekeys"),
			URL:                   ksURL.String(),
			Logger:                logger,
		},
		DB:                    keyshareserver.NewMemoryDB(),
		JwtKeyID:              keyshareJwtKeyID,
		JwtPinExpiry:          int(pinExpiry.Seconds()),
		JwtPrivateKeyFile:     filepath.Join(testdataPath, "jwtkeys", fmt.Sprintf("%s-kss-sk-%d.pem", scheme, keyshareJwtKeyID)),
		StoragePrimaryKeyFile: filepath.Join(testdataPath, "keyshareStorageTestkey"),
		// The credential the keyshare server issues on enrollment. The second
		// segment is the issuer inside the scheme, not the scheme name again.
		KeyshareAttribute: irma.NewAttributeTypeIdentifier(fmt.Sprintf("%s.test.mijnirma.email", scheme)),
	})
	if err != nil {
		return nil, fmt.Errorf("keyshareserver.New: %w", err)
	}

	// Bind before returning, so an enrollment fired immediately after this call
	// cannot race the listener.
	ln, err := net.Listen("tcp", ksURL.Host)
	if err != nil {
		srv.Stop()
		return nil, fmt.Errorf("listen on %s (the address scheme %s names): %w", ksURL.Host, scheme, err)
	}
	k := &localKeyshareServer{URL: ksURL.String(), srv: srv}
	handler := srv.Handler()
	k.http = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if keyshareProofPaths[r.URL.Path] {
			k.proofRequests.Add(1)
		}
		if keysharePinPaths[r.URL.Path] {
			k.pinAuthRequests.Add(1)
		}
		handler.ServeHTTP(w, r)
	})}
	go func() { _ = k.http.Serve(ln) }()
	return k, nil
}

// Stop shuts down the HTTP server and the keyshare server behind it.
func (k *localKeyshareServer) Stop() {
	_ = k.http.Close()
	k.srv.Stop()
}
