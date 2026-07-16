# Crypto-compat fixtures

Golden ciphertexts pinning PostGuard's **wire format across time** (EPIC issue
[#206](https://github.com/encryption4all/postguard/issues/206)). The rest of
the harness tests HEAD-vs-HEAD; these fixtures are the time axis: a ciphertext
sealed **today** — like every encrypted email and file already in the wild —
must decrypt **forever**, until a format break is made deliberately and
versioned.

## Layout

Each `pg-wasm-<version>/` directory is a self-contained set:

| File | What |
|---|---|
| `stream.bin` | streaming container (`sealStream` — what cryptify stores, pg-js uploads) |
| `mem.bin` | in-memory container (`seal` — pg-js `toBytes()`) |
| `vk.json` | the PKG `/v2/sign/parameters` response (IBS verifying key) |
| `usk.json` | the PKG `/v2/irma/key/{ts}` response (recipient's IBE user secret key) |
| `mpk.json` | the PKG `/v2/parameters` response (master public key; kept for resealing/debugging) |
| `meta.json` | sealer version, recipient id, policy, timestamp, plaintext, sender |

The key material is committed alongside because the e2e stack's IBE keys are
ephemeral (regenerated per image build) — a fixture must carry everything
needed to unseal it. These are **test keys for test data**; nothing here
protects anything real.

## Verifiers (both run in CI, stack-free)

- **`verify.mjs`** (here): unseals every set with the **pinned published
  `@e4a/pg-wasm`** — the client side of the contract.
  `npm ci && npm run verify`
- **[`../fixtures-verify/`](../fixtures-verify/)**: unseals every set with the
  **current working-tree `pg-core`** (sibling `../../postguard` checkout) — the
  drift detector. Bumping `VERSION_V3`, the bincode framing, or the header
  layout turns it red with e.g. `IncorrectVersion { expected: 3, found: 2 }`.
  `cargo run`

A red verifier is not necessarily a bug — it may be a deliberate format
change. It **is** always a decision: either fix the accidental break, or ship
the new format with explicit multi-version support and add a new fixture set
for it (never delete old sets — old ciphertexts don't disappear from inboxes).

## Regenerating / adding a set

Generation is rare and deliberate (new published pg-wasm, new format version):

```bash
cd ../stack && PG_API_KEY=… docker compose up -d
cd ../yivi-driver
PG_GENERATE_FIXTURES=1 PG_API_KEY=… go test -run TestGenerateCryptoFixtures -v
```

The generator seals with the pg-wasm pinned in `yivi-driver/oracle/package.json`,
self-checks a round-trip, and writes `pg-wasm-<version>/`. Commit the result.

## Wanted: fixtures sealed by other clients

- **`E4A.PostGuard` (.NET)** — blocked on
  [#236](https://github.com/encryption4all/postguard/issues/236): the SDK
  hardcodes pbdf recipient policies and no test environment can mint a USK for
  a pbdf identity, so a .NET-sealed fixture couldn't be decrypt-verified yet.
- Older published `@e4a/pg-wasm` versions, as they ship.
