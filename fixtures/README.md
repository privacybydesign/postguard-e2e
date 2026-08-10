# The container corpus

Golden ciphertexts pinning PostGuard's **wire format across time** (EPIC
[#206](https://github.com/encryption4all/postguard/issues/206), corpus in
[#19](https://github.com/encryption4all/postguard-e2e/issues/19) /
[#23](https://github.com/encryption4all/postguard-e2e/issues/23)). The rest of
the harness tests HEAD against HEAD; this is the time axis. A container sealed
**today** — like every encrypted email and file already in the wild — must open
**forever**, until a format break is made deliberately and versioned.

## The rule: append-only

**No file inside a fixture set is ever edited, renamed or deleted.** Not to fix
a typo in `meta.json`, not to shrink a file, not to "regenerate with the current
writer". A golden artifact is a stand-in for a ciphertext in somebody's mailbox,
and that ciphertext does not get edited either. A new format, a new writer or a
corrected sample is a **new directory alongside** the old one.

Two independent checks enforce it, and they need each other:

| Check | Runs on | Catches |
|---|---|---|
| `npm run ledger` — every artifact's sha256 against `CORPUS.sha256` | every event, including the nightly schedule and pushes that never opened a PR | a deleted or edited artifact, and an added one with no ledger line |
| `npm run append-only` — the diff against the merge base | pull requests (the only event with a merge base) | the same, *plus* a rewritten `CORPUS.sha256` line — the cover-up the ledger alone would accept |

Editing a fixture fails the ledger. Editing a fixture *and* its ledger line
leaves the ledger self-consistent, and fails the diff check instead. Both are
wired into the `crypto-fixtures` job in
[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml), and both are
themselves tested: `append-only.test.mjs` builds a throwaway repository, deletes
and edits a fixture in it, and asserts the gate goes red — because a gate only
ever observed reporting success has not been observed.

The gates, this README and `gen/` are **not** part of the corpus: they stay
editable, or the corpus could never gain a reader. `corpus.mjs` owns that
distinction (`isCorpusPath`) so every gate draws the line in the same place.

If a verifier goes red, that is never automatically a bug — it may be a
deliberate format change. It is always a **decision**: fix the accidental break,
or ship the new format with explicit multi-version support and add a new set for
it. What it is never is a reason to delete a fixture.

## What is in the corpus

One directory per pinned **published writer**. Published, because the corpus
only means something if the bytes are what a released client really produced;
HEAD-sealed bytes are the forward direction and belong to
[#25](https://github.com/encryption4all/postguard-e2e/issues/25) and to
postguard's own `wire-compat-rust` gate.

| Set | Writer | Containers | Sealed |
|---|---|---|---|
| `pg-wasm-0.6.1/` | `@e4a/pg-wasm` 0.6.1 (npm) | `mem.bin`, `stream.bin` — public signature only | live e2e stack, real Yivi disclosure |
| `pg-core-0.6.1/` | `pg-core` 0.6.1 (crates.io) | `mem.bin`, `stream.bin`, `mem-privsig.bin`, `stream-privsig.bin` | `gen/`, deterministic |
| `pg-core-0.5.10/` | `pg-core` 0.5.10 (crates.io) | same four | `gen/`, deterministic |

The two `pg-core` versions are the crates.io rows of the machine-read
`Reader list` block in postguard's `COMPATIBILITY.md` — the declared support
window. What we promise to *read* is a sensible list of writers to *archive*.

Both container modes are covered because they are different wire formats, and
this is the seam behind
[postguard#127](https://github.com/encryption4all/postguard/issues/127):

- **memory** (`Sealer<_, SealerMemoryConfig>::seal`, pg-wasm `seal()`, what
  pg-js `toBytes()` callers *think* they get)
- **stream** (the segmented container: what cryptify stores and pg-js uploads)

and both signing shapes, because a private signing policy lands in the header in
memory mode and in the encrypted payload trailer in stream mode:

- **public signature only** (`*.bin`)
- **private signing policy** (`*-privsig.bin`) — the claims a reader may only
  see after decrypting

### Files in a set

| File | What |
|---|---|
| `*.bin` | the containers, listed in `meta.json` |
| `vk.json` | PKG `/v2/sign/parameters` response (IBS verifying key) |
| `usk.json` | PKG `/v2/irma/key/{ts}` response (recipient's IBE user secret key) |
| `mpk.json` | PKG `/v2/parameters` response (master public key) |
| `signkey.json` | PKG `POST /v2/irma/sign/key` response — only in generated sets; it is what lets a future writer seal into an existing key universe |
| `meta.json` | schema version, writer, recipient, sender, and one entry per container |

Key material is committed because the e2e stack's IBE keys are ephemeral
(regenerated per image build): a fixture has to carry everything needed to open
it. These are **test keys for test data**; nothing here protects anything real.

`meta.json` has two schemas, and both stay supported forever, because schema 1
sets can never be migrated — editing them is exactly what the rule forbids:

- **1** — no `containers` list: it means `mem.bin` + `stream.bin`, public
  signature only, with one set-wide `plaintextB64`.
- **2** — a `containers` list, one plaintext per container, so a set can carry
  more than the two classic files.

A verifier that meets a schema it does not know **fails**; it never skips. A
corpus job that reads nothing and reports success is worse than no job.

## Verifiers

Three readers, because they answer different questions. All are stack-free.

| Verifier | Reader | Question |
|---|---|---|
| `npm run verify` | `@e4a/pg-wasm`, pinned published | does the JS layer that owns the container format still open the corpus? |
| `npm run verify` | `@e4a/pg-js`, current | does the SDK websites and add-ons actually ship still open it? |
| [`../fixtures-verify/`](../fixtures-verify/) — `cargo run` | working-tree `pg-core` (sibling `../../postguard` checkout) | is the code about to become the next release still compatible? |

Each checks the recovered plaintext, that the header lists the recipient, the
verified public sender policy, and that a private signing policy is present
exactly when the container was sealed with one — a reader that reports claims
nobody signed is as wrong as one that loses them.

**`pg-js` cannot read a memory-mode container**, and that is structural rather
than a defect: it decrypts through `StreamUnsealer` in both of its input modes,
and never writes one either (`toBytes()` seals with `sealStream`). The corpus
does not skip those cases for it — it **asserts the refusal**, by message
(`mode is not supported: InMemory { size: N }`). So a memory container that
fails for any *other* reason is a real break rather than a skip in disguise, and
a `pg-js` that one day *does* open one turns the job red until
`readers.mjs` records the new support story. Memory mode itself is not left
unread: `@e4a/pg-wasm` and `pg-core` both cover it.

Both verifiers run **one child process per case**. A reader handed a container
whose header layout it no longer agrees with does not reliably return an error:
it can read a garbage length prefix and abort on the allocation
(`memory allocation of N bytes failed`, SIGABRT). An abort is not a panic, so no
`catch` contains it, and in one process the first such container would take
every remaining one with it. Per-case children also mean the failure line names
the container that died and the signal that killed it.

## Adding a writer's artifacts

Never regenerate; only append.

For a **published `pg-core`** (the generator already speaks this):

```sh
cd gen
# add a renamed dependency + a writer!() line if the version is new; note that
# two `=` pins of the same crate only coexist when they are semver-INCOMPATIBLE
cargo run --locked -- 0.6.1 ../pg-core-0.6.1
cd .. && npm run ledger:write     # appends the new lines; review the diff
npm run verify && (cd ../fixtures-verify && cargo run)
```

The generator refuses to write into a directory that already holds part of a
set, so "regenerate in place" is not an available accident. Its output is a pure
function of one seed — master keys, USKs, signatures, IVs and therefore every
sealed byte — so generating into an empty directory and diffing is how you check
committed bytes against a writer.

For a **published `@e4a/pg-wasm`, `@e4a/pg-js` or the .NET SDK**, seal into an
existing set's key universe: `mpk.json` and `signkey.json` are the sealer inputs
and `usk.json` is what proves the result opens. Write the new containers into a
new `<sdk>-<version>/` directory with its own `meta.json` (schema 2) and copy
the key files beside them, so the set stays self-contained.

For a fixture from the **live stack** (a real Yivi disclosure, which is how
`pg-wasm-0.6.1/` was made):

```sh
cd ../stack && PG_API_KEY=… docker compose up -d
cd ../yivi-driver
PG_GENERATE_FIXTURES=1 PG_API_KEY=… go test -run TestGenerateCryptoFixtures -v
```

Then `npm run ledger:write` and commit. The ledger diff should be additions
only — if it is not, something regenerated an existing set and the pull request
will say so.

## Wanted

- `E4A.PostGuard` (.NET) — unblocked by
  [postguard#236](https://github.com/encryption4all/postguard/issues/236) /
  [#244](https://github.com/encryption4all/postguard/issues/244); it is the
  writer nothing in this corpus covers.
- Older published `@e4a/pg-wasm` lines, as the support window declares them.
- A multi-recipient set: every container here is sealed for one recipient, so
  the multi-recipient KEM entries in the header are exercised by postguard's
  own gate and not by this corpus.
