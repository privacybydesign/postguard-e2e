# yivi-driver — headless Yivi holder for automated tests

A **headless Yivi client** (no phone) that can issue itself credentials and
complete disclosure sessions programmatically. This is the keystone for the
PostGuard e2e harness: it lets CI drive a real Yivi disclosure — and therefore
a real PostGuard **decryption** — end to end, which was previously assumed to
require a physical device (see the note in `../README.md`).

It wraps irmago's `client.Client` (the same holder the Yivi mobile app is built
on) behind a small `YiviDriver` that auto-grants issuance/disclosure permission.
The driver is deliberately behind a narrow contract (`RunSession(qr)`), so a
real-device (Appium/emulator) backend can be slotted in later — EPIC issue #204,
layer **L3b**.

## Self-test

`main.go` proves the mechanism against an in-process irma-server seeded with
irmago's bundled test schemes + issuer private keys:

```
go run .
```

Expected:

```
issued irma-demo.RU.studentCard to holder
disclosure proof status: VALID (1 disjunction(s) disclosed)
  disclosed irma-demo.RU.studentCard.level = "PhD"
OK: headless holder issued a credential and produced a VALID disclosure proof (no phone)
```

The success criterion is `ProofStatus == VALID` — i.e. the holder produced a
cryptographically valid disclosure proof that the server verified.

## Reuse as a library

`YiviDriver` (in `driver.go`) is the reusable piece:

```go
d, _ := NewYiviDriver(storagePath, irmaConfigAssets, eudiPath)
defer d.Close()
d.RunSession(qr) // qr = the *irma.Qr the PKG/irma-server returns for a session
```

`NewYiviDriver` sets `DeveloperMode: true` so the holder will talk to a
plain-HTTP dev irma-server; production irma-servers are HTTPS-only.

## Configuration

Defaults point at the sibling checkouts / provisioned scheme; override via env:

| Var | Default | Purpose |
|---|---|---|
| `IRMA_SCHEME_ROOT` | `../stack/schemes/irma_configuration` | scheme dir (holds `irma-demo/`) the stack tests trust — the pinned real scheme from `stack/schemes/provision.sh`. |
| `IRMA_EMAIL_ATTRIBUTE` | `irma-demo.sidn-pbdf.email.email` | sender email attribute type the stack signs with; must match the PKG/cryptify knobs (postguard#236). |
| `IRMAGO_ROOT` | `/Users/rubenhensen/Repos/irmago` | only used by the `go run .` self-test's in-process server (irmago's bundled testdata). |
| `YIVI_DRIVER_AES_KEY` | _(random per run)_ | hex-encoded 32-byte key for the holder's local storage encryption. Set it (64 hex chars) only when the on-disk state must survive restarts; otherwise a fresh random key is generated each run. |

## Tests

- **Self-test (no stack):** `go run .` — in-process irma-server, proves
  headless issue → disclose → VALID proof.
- **PKG integration (needs the stack):** `integration_test.go` — issues a
  credential via the irma-server, has the **PKG** start a disclosure, drives the
  headless holder, and asserts the PKG returns a valid JWT.

- **Golden flow (needs the stack + oracle deps):** `golden_flow_test.go` — the
  full happy path: seal + sign (business API key) → cryptify upload → assert
  notification email in mailcrab → download → headless disclose → USK →
  **decrypt** → verify plaintext + sender. Go orchestrates; a small Node
  `oracle/` does the pg-wasm `seal`/`unseal` (see [`oracle/`](oracle/)).

  ```bash
  cd ../stack && docker compose up -d
  cd ../yivi-driver/oracle && npm install     # once, for the crypto oracle
  cd .. && go test -v                         # runs both integration tests
  ```

  Both skip automatically if the stack isn't running.

## Status

- ✅ **#204:** headless holder — self-test (in-process VALID proof) +
  `TestPKGInitiatedDisclosureYieldsJWT` (PKG-initiated disclosure → valid JWT).
- ✅ **#203:** `../stack` brings up PKG + irma-server + cryptify + mailcrab
  (+ a business-db on postguard-business's real schema) with the irma-server
  wired for test-scheme issuance.
- ✅ **#205:** full golden flow — `TestGoldenFlow` seals, uploads, emails,
  discloses (headless), decrypts, and verifies — no phone, no browser.

## Prerequisites

- **CGO + the native SQLCipher library.** irmago's `client.Client` pulls in
  `eudi/storage` → `eudi/storage/db/sqlcipher`, which is a CGO binding. Building
  or testing this module therefore needs a C toolchain and `libsqlcipher`
  discoverable via `pkg-config` (`CGO_ENABLED=1`, the default). Without it,
  `go build` fails with `undefined: Connector`. Install it with e.g.
  `brew install sqlcipher` (macOS) or `apt-get install libsqlcipher-dev`
  (Debian/Ubuntu). CI must install it before `go test`.
- **Node** (for the golden-flow crypto oracle) and **Go 1.26+**.

## Build notes

`go.mod` uses a `replace` onto the local irmago (EUDI) checkout for development.
For CI, pin a published irmago version instead. The driver implements the
`irmaclient.Signer` interface itself (`signer.go`) rather than importing
irmago's internal test signer, so it builds from outside the irmago module.
