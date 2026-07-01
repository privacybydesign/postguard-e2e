package main

import (
	"crypto/ecdsa"

	"github.com/privacybydesign/gabi/signed"
)

// deviceSigner implements irmaclient.Signer with an in-memory ECDSA key,
// mirroring irmago's internal test signer (internal/test/signer.go). A real
// wallet keeps this key in secure hardware; for a headless test holder an
// ephemeral key is fine.
type deviceSigner struct{ key *ecdsa.PrivateKey }

func newDeviceSigner() (*deviceSigner, error) {
	k, err := signed.GenerateKey()
	if err != nil {
		return nil, err
	}
	return &deviceSigner{key: k}, nil
}

func (s *deviceSigner) PublicKey(string) ([]byte, error) {
	return signed.MarshalPublicKey(&s.key.PublicKey)
}

func (s *deviceSigner) Sign(_ string, msg []byte) ([]byte, error) {
	return signed.Sign(s.key, msg)
}
