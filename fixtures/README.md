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

The gates, this README and the `gen*/` writer crates are **not** part of the
corpus: they stay editable, or the corpus could never gain a reader.
`corpus.mjs` owns that distinction (`isCorpusPath`) so every gate draws the line
in the same place.

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
| `pg-core-0.6.4/` | `pg-core` 0.6.4 (crates.io) | same four | `gen-0-6-4/`, deterministic |
| `pg-core-0.6.4-tampered/` | `pg-core` 0.6.4, then edited | `mem.bin`, `stream.bin` and three containers that must be **rejected** | `gen-0-6-4/ --tampered`, deterministic |

0.6.1 and 0.5.10 were the crates.io rows of the machine-read `Reader list` block
in postguard's `COMPATIBILITY.md` when they were archived — the declared support
window, whose 0.6.1 row has since moved to 0.6.3. What we promise to *read* is a
sensible list of writers to *archive*.

0.6.4 is in the corpus for a different reason. It is the first release that
writes the AEAD-protected copy of the sender's public signing policy
([postguard#347](https://github.com/encryption4all/postguard/issues/347)), so it
is the first writer here that seals containers in that format; before this set
the archival guarantee said nothing about it. 0.6.4 also canonicalizes identity
attribute values before deriving
([postguard#335](https://github.com/encryption4all/postguard/issues/335)), but
every attribute value in this set is already canonical — `mpk.json`, `vk.json`,
`usk.json` and `signkey.json` are byte-identical to the 0.5.10 and 0.6.1 sets,
which is the evidence that no derivation moved — so the set pins the `pub_pol`
half of the 0.6.4 era and not the canonicalization half. The pinned
`@e4a/pg-wasm` 0.6.1 predates the field and opens these containers anyway —
postguard#347 says it should, and this set is where that keeps being checked.

### The expected-failure class

`pg-core-0.6.4-tampered/` holds the containers a reader is supposed to
**refuse**. Each keeps its twin's preamble, header and payload byte
for byte and replaces only the header signature block, with one made over the
same header bytes by another signing key carrying that key's policy — the attack
[postguard#347](https://github.com/encryption4all/postguard/issues/347) is about.
`pg-core`'s own `swap_header_signature` is the reference implementation.

| Container | Twin | Kind | What it claims |
|---|---|---|---|
| `mem-spoofed.bin` | `mem.bin` | `swapped-signer` | `attacker@golden.test`, a different sender entirely |
| `stream-spoofed.bin` | `stream.bin` | `swapped-signer` | the same, in the segmented container |
| `mem-respelled.bin` | `mem.bin` | `respelled-sender` | `Sender@Golden.TEST` — the real sender, respelled |

The twins come from the 0.6.4 set because 0.6.4 is the first writer that puts
the AEAD-protected copy of the sender's policy in the container. A tampered copy
of an older set could not be caught by *any* reader, ever, since the check is
guarded on that copy being there.

`mem-respelled.bin` earns its place because the check is byte equality on the
policy and not identity equality, so a respelling that derives the same sender
is rejected too — which is what separates a reader that only reads the header
from one that reads the copy under the AEAD. Public signing only: the swap is on
the public block, so a `*-privsig` twin would mostly re-pin what the positive
containers already cover.

A **separate directory**, not three more files in `pg-core-0.6.4/`, because a
container is only declared by writing it into `meta.json` and every file inside
a set is frozen the moment it lands. The key material and the two twins are
byte-identical to the positive set's, so "the tamper differs from its twin only
in the signature block" is checkable with `cmp`.

`meta.json` records what each container **is** — its kind, its twin, and the
address it now claims — and never what a reader must do about it: the file is
frozen forever, and every reader older than the fix decrypts these and recovers
the plaintext, which is why `plaintextB64` is still there and still checked.
What each reader *does* is in `readers.mjs`, which is tooling and can move as
pins do.

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
| `attacker-signkey.json` | the same response for the identity a tampered container claims — committed so the tamper stays reproducible; only in `pg-core-0.6.4-tampered/` |
| `meta.json` | schema version, writer, recipient, sender, and one entry per container |

Key material is committed because the e2e stack's IBE keys are ephemeral
(regenerated per image build): a fixture has to carry everything needed to open
it. These are **test keys for test data**; nothing here protects anything real.

`meta.json` has three schemas, and all of them stay supported forever, because a
set can never be migrated — editing it is exactly what the rule forbids:

- **1** — no `containers` list: it means `mem.bin` + `stream.bin`, public
  signature only, with one set-wide `plaintextB64`.
- **2** — a `containers` list, one plaintext per container, so a set can carry
  more than the two classic files.
- **3** — the same layout as 2, on the sets sealed from `pg-core` 0.6.4 on. The
  version exists so a field can later be added to 3 and a reader that knows only
  1 and 2 refuses those sets rather than reading past it. That field is
  `tampered`, above: a container carrying it is one the corpus expects a reader
  to reject.

A verifier that meets a schema it does not know **fails**; it never skips. A
corpus job that reads nothing and reports success is worse than no job.

## Verifiers

Four readers, because they answer different questions. All are stack-free.

| Verifier | Reader | Question |
|---|---|---|
| `npm run verify` | `@e4a/pg-wasm`, pinned published | does the JS layer that owns the container format still open the corpus? |
| `npm run verify` | `@e4a/pg-js`, current | does the SDK websites and add-ons actually ship still open it? |
| `npm run verify` | `@e4a/pg-wasm` 0.6.4, pinned permanently | did the fix that refuses a swapped sender work in the release that shipped it, and does it still? |
| [`../fixtures-verify/`](../fixtures-verify/) — `cargo run` | working-tree `pg-core` (sibling `../../postguard` checkout) | is the code about to become the next release still compatible? |

Each checks the recovered plaintext, that the header lists the recipient, the
verified public sender policy, and that a private signing policy is present
exactly when the container was sealed with one — a reader that reports claims
nobody signed is as wrong as one that loses them.

The 0.6.4 pin is permanent and the 0.6.1 pin does not move either. What each
freezes is different: 0.6.1 is the client half of the archival contract, and
0.6.4 is *that the fix worked as shipped* — a floating pin there would only
duplicate `fixtures-verify` and would stop testing 0.6.4 the day 0.6.5 lands.
It is installed as an npm alias (`pg-wasm-0-6-4`) because `pg-js` declares
`^0.6.1` and npm dedupes a plain second dependency onto the top-level copy.

On a **tampered** container each reader is held to what `readers.mjs` records
for it, in the same way `cannotOpen` records a reader's structural limits: a
reader recorded as rejecting must reject, and one recorded as opening must open
and report the address the container claims. Four things are asserted together,
because the error a rejecting reader raises is the one plain corruption raises
too, so "it threw" would pass on a fixture that is merely broken:

1. the good twin still opens, plaintext and sender verified;
2. the tampered container's header still parses, and lists the same recipients
   as the twin;
3. the identity reported *before* decrypting is the swapped-in one;
4. only `unseal` fails, and with the message `readers.mjs` records for it.

A reader that refuses before it reads the payload has no 2 or 3 to be asked
about — the container it would parse is one it will not touch. There, 1 and the
recorded message are the whole assertion, which is why the message is not
optional: a missing file and a truncated container throw there too.

Two readers reject: `@e4a/pg-wasm` 0.6.4 and the working-tree `pg-core`. Two
record the non-rejection — `@e4a/pg-wasm` 0.6.1 and the current `pg-js` open the
spoofed containers and report `attacker@golden.test` as the verified sender,
with the real sender surfacing as a *private* policy. That is the blast radius
of the bug written down, and it turns a future pin bump into a visible failure
rather than a silent change. Both also refuse `mem-respelled.bin` outright,
which is not the tamper check finding anything: they predate canonicalization
([postguard#335](https://github.com/encryption4all/postguard/issues/335)) and so
cannot derive the signer identity from a respelled policy at all. That reason is
recorded beside the refusal, so it is not read as the fix being present.

`verify.test.mjs` is the proof those expectations bite: it copies the corpus and
requires every case to go red twice over — once with the good twin put in the
tampered container's place, and once with the container zeroed. A good container
passing a negative assertion can only mean the assertion was decoration; a
broken one passing means it was satisfied by any throw at all.

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

For a **published `pg-core`** (the generators already speak this):

```sh
cd gen-<pin>                      # the crate that pins the version you want
cargo run --locked -- <version> ../pg-core-<version>
cd .. && npm run ledger:write     # appends the new lines; review the diff
npm run verify && (cd ../fixtures-verify && cargo run)
```

`gen-0-6-4` also seals the expected-failure set, into a directory of its own:

```sh
cd gen-0-6-4
cargo run --locked -- 0.6.4 ../pg-core-0.6.4-tampered --tampered
```

One crate per pin, and a new one when the version shares its minor with a pin
that already exists: two `=` pins of the same crate only coexist when they are
semver-INCOMPATIBLE, because cargo keeps one copy per compatible range. Copy the
nearest `gen*/` directory, move the pin, and add it to the `NOT_A_SET` list in
`corpus.mjs` and in `../fixtures-verify/src/main.rs` — a generator directory
that is missing from those is read as a fixture set and fails on its absent
`meta.json`. It also needs a `target/` line in the root `.gitignore` and a
`cargo fmt --check` step in the `fmt` job of
[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml).

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
