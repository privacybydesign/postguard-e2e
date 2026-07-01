package main

import (
	"encoding/json"
	"fmt"
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
	c      *pgclient.Client
	states chan clientmodels.SessionState
	nextID int
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
	var aesKey [32]byte
	copy(aesKey[:], "asdfasdfasdfasdfasdfasdfasdfasdf")

	c, err := pgclient.New(
		storagePath,
		irmaConfigAssets,
		eudiPath,
		irmaclient.NewMockClientHandler(),
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
	return &YiviDriver{c: c, states: states}, nil
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
	// subsequent RunSession (buffered so a grant that lands after we've already
	// returned via timeout doesn't block its goroutine).
	grantErr := make(chan error, 1)

	for {
		select {
		case st := <-d.states:
			if st.Id != id {
				continue
			}
			switch st.Status {
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
