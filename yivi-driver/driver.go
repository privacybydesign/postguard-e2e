package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	pgclient "github.com/privacybydesign/irmago/client"
	"github.com/privacybydesign/irmago/client/clientsettings"
	"github.com/privacybydesign/irmago/common/clientmodels"
	"github.com/privacybydesign/irmago/irma"
	"github.com/privacybydesign/irmago/irma/irmaclient"
)

// chanHandler implements clientmodels.SessionHandler by forwarding every
// session-state update onto a channel the driver polls.
type chanHandler struct {
	ch chan clientmodels.SessionState
}

func (h *chanHandler) UpdateSession(s clientmodels.SessionState) { h.ch <- s }

// YiviDriver is a headless Yivi holder for automated tests: it wraps an irmago
// client.Client and auto-grants issuance/disclosure permission, always picking
// the first credential option that satisfies each disclosure disjunction.
//
// This is the swappable driver referenced by EPIC issue #204 — a real-device
// (Appium) backend can implement the same "run this session pointer to
// completion" contract later.
type YiviDriver struct {
	c       *pgclient.Client
	handler *irmaclient.MockClientHandler
	states  chan clientmodels.SessionState
	nextID  int

	// pin is empty until KeyshareEnroll succeeds; a session that asks for a PIN
	// before that is an error, not something to guess an answer for.
	pin string
	// pinRequests counts the PIN prompts answered over this holder's lifetime,
	// so a test can assert the keyshare leg was actually walked.
	pinRequests int
}

// NewYiviDriver builds a holder. storagePath and eudiPath are (created)
// scratch dirs; irmaConfigAssets points at an irma_configuration to seed the
// holder's scheme trust (e.g. irmago's testdata/irma_configuration).
func NewYiviDriver(storagePath, irmaConfigAssets, eudiPath string) (*YiviDriver, error) {
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		return nil, err
	}
	signer, err := newDeviceSigner()
	if err != nil {
		return nil, err
	}
	states := make(chan clientmodels.SessionState, 16)
	aesKey, err := loadAESKey()
	if err != nil {
		return nil, err
	}

	handler := irmaclient.NewMockClientHandler()
	c, err := pgclient.New(
		storagePath,
		irmaConfigAssets,
		eudiPath,
		handler,
		&chanHandler{ch: states},
		signer,
		aesKey,
	)
	if err != nil {
		return nil, err
	}
	// DeveloperMode lets the holder talk to a plain-HTTP dev irma-server
	// (session transports set ForceHTTPS = !DeveloperMode); production stays HTTPS-only.
	c.SetPreferences(clientsettings.Preferences{DeveloperMode: true})
	return &YiviDriver{c: c, handler: handler, states: states}, nil
}

// KeyshareEnroll registers the holder with the keyshare server of scheme, which
// takes over half of its secret key for that scheme's credentials. pin is
// remembered and used to answer the PIN prompts every later session over a
// keyshare-backed credential raises. Blocks until the keyshare server answers.
func (d *YiviDriver) KeyshareEnroll(scheme irma.SchemeManagerIdentifier, pin string) error {
	d.c.KeyshareEnroll(scheme, nil, pin, "en")
	if err := d.handler.AwaitEnrollmentResult(); err != nil {
		return fmt.Errorf("keyshare enrollment with %s: %w", scheme, err)
	}
	d.pin = pin
	return nil
}

// PinRequests is how many keyshare PIN prompts this holder has answered. A
// keyshare-backed flow that reports zero did not go through the keyshare server.
func (d *YiviDriver) PinRequests() int { return d.pinRequests }

// aesKeyEnv is the env var used to supply a fixed storage-encryption key so
// the holder's on-disk state survives restarts. Its value must be 64 hex
// characters (32 bytes). When unset, a fresh random key is generated per run,
// which is the right default for the throwaway scratch storage this driver
// uses in tests.
const aesKeyEnv = "YIVI_DRIVER_AES_KEY"

// loadAESKey returns the 32-byte key used to encrypt the holder's local
// storage. It reads a hex-encoded key from aesKeyEnv when set (for storage
// that must persist across restarts), otherwise it generates a cryptographically
// random key.
func loadAESKey() ([32]byte, error) {
	var aesKey [32]byte
	if v := os.Getenv(aesKeyEnv); v != "" {
		b, err := hex.DecodeString(v)
		if err != nil {
			return aesKey, fmt.Errorf("%s must be hex-encoded: %w", aesKeyEnv, err)
		}
		if len(b) != len(aesKey) {
			return aesKey, fmt.Errorf("%s must decode to %d bytes, got %d", aesKeyEnv, len(aesKey), len(b))
		}
		copy(aesKey[:], b)
		return aesKey, nil
	}
	if _, err := io.ReadFull(rand.Reader, aesKey[:]); err != nil {
		return aesKey, fmt.Errorf("generate storage key: %w", err)
	}
	return aesKey, nil
}

func (d *YiviDriver) Close() { d.c.Close() }

// RunSession drives one IRMA session (issuance or disclosure) to completion,
// auto-granting permission. qr is the session pointer returned by the server
// (or proxied by the PKG). Returns nil on Status_Success.
func (d *YiviDriver) RunSession(qr *irma.Qr) error {
	d.nextID++
	id := d.nextID

	reqData := pgclient.SessionRequestData{Qr: *qr, Protocol: clientmodels.Protocol_Irma}
	j, err := json.Marshal(reqData)
	if err != nil {
		return err
	}
	d.c.NewSession(id, string(j))

	// Per-session error channel so a late grant failure can't leak into a
	// subsequent RunSession. One slot per interaction goroutine we may start
	// (permission, PIN), so one that fails after we've already returned via
	// timeout still doesn't block on the send.
	grantErr := make(chan error, 2)

	// The client re-emits Status_RequestPin after a rejected PIN. We only ever
	// send the enrolled one, so a second prompt means something is wrong —
	// bound it instead of resubmitting until the timeout fires.
	pinPrompts := 0

	for {
		select {
		case st := <-d.states:
			if st.Id != id {
				continue
			}
			switch st.Status {
			case clientmodels.Status_RequestPin:
				if d.pin == "" {
					return fmt.Errorf("session %d asked for a keyshare PIN but this holder is not enrolled — call KeyshareEnroll first", id)
				}
				pinPrompts++
				if pinPrompts > 1 {
					return fmt.Errorf("session %d asked for a keyshare PIN again after the enrolled one was submitted", id)
				}
				d.pinRequests++
				// Blocks until the client has processed the PIN, same as the
				// permission grant below, so keep it off the polling goroutine.
				go d.enterPin(id, grantErr)
			case clientmodels.Status_RequestPermission:
				choices, err := disclosureChoices(st)
				if err != nil {
					return err
				}
				// HandleUserInteraction blocks until the client processes the
				// grant and emits the next state, so run it off the polling
				// goroutine (mirrors irmago's own test helper).
				go d.grant(id, choices, grantErr)
			case clientmodels.Status_Success:
				return nil
			case clientmodels.Status_Error, clientmodels.Status_Dismissed:
				return fmt.Errorf("session %d ended with %s: %+v", id, st.Status, st.Error)
			}
		case err := <-grantErr:
			return err
		case <-time.After(30 * time.Second):
			return fmt.Errorf("session %d timed out waiting for completion", id)
		}
	}
}

func (d *YiviDriver) grant(id int, choices []clientmodels.DisclosureDisconSelection, grantErr chan<- error) {
	if err := d.c.HandleUserInteraction(clientmodels.SessionUserInteraction{
		SessionId: id,
		Type:      clientmodels.UI_Permission,
		Payload: clientmodels.SessionPermissionInteractionPayload{
			Granted:           true,
			DisclosureChoices: choices,
		},
	}); err != nil {
		// Surface it so RunSession returns the real cause instead of a 30s timeout.
		grantErr <- fmt.Errorf("granting permission for session %d: %w", id, err)
	}
}

func (d *YiviDriver) enterPin(id int, errCh chan<- error) {
	if err := d.c.HandleUserInteraction(clientmodels.SessionUserInteraction{
		SessionId: id,
		Type:      clientmodels.UI_EnteredPin,
		Payload:   clientmodels.PinInteractionPayload{Pin: d.pin, Proceed: true},
	}); err != nil {
		errCh <- fmt.Errorf("entering keyshare PIN for session %d: %w", id, err)
	}
}

// disclosureChoices auto-selects the first owned option for each disjunction
// in the disclosure plan (nil for a pure issuance session).
func disclosureChoices(st clientmodels.SessionState) ([]clientmodels.DisclosureDisconSelection, error) {
	if st.DisclosurePlan == nil {
		return nil, nil
	}
	var choices []clientmodels.DisclosureDisconSelection
	for i, pick := range st.DisclosurePlan.DisclosureChoicesOverview {
		if len(pick.OwnedOptions) == 0 {
			return nil, fmt.Errorf("disclosure disjunction %d has no owned option to satisfy it", i)
		}
		choices = append(choices, makeChoice(pick.OwnedOptions[0]))
	}
	return choices, nil
}

// makeChoice turns a DisclosureBundle into a selection of all its non-header
// attributes (ported from irmago's session_helpers_test.go makeDisclosureChoice).
func makeChoice(b *clientmodels.DisclosureBundle) clientmodels.DisclosureDisconSelection {
	creds := make([]clientmodels.SelectedCredential, 0, len(b.Credentials))
	for _, opt := range b.Credentials {
		var paths [][]any
		for _, attr := range opt.Attributes {
			if attr.Value == nil {
				continue // skip section headers
			}
			paths = append(paths, attr.ClaimPath)
		}
		creds = append(creds, clientmodels.SelectedCredential{
			CredentialId:   opt.CredentialId,
			CredentialHash: opt.Hash,
			AttributePaths: paths,
		})
	}
	return clientmodels.DisclosureDisconSelection{Credentials: creds}
}
