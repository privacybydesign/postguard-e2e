# postguard-e2e

> Part of [PostGuard](https://postguard.eu) · full docs at [docs.postguard.eu](https://docs.postguard.eu)

The central end-to-end test harness for PostGuard (EPIC:
[encryption4all/postguard#201](https://github.com/encryption4all/postguard/issues/201)).
It has three parts:

- **[`stack/`](stack/)** — a self-contained docker-compose stack (PKG + irma-server
  + cryptify + mailcrab), with the irma-server wired for test-scheme issuance so
  automated end-to-end flows (incl. decryption) are possible. *(issue #203)*
- **[`yivi-driver/`](yivi-driver/)** — a **headless Yivi holder** that issues and
  discloses credentials with no phone, so CI can drive a real disclosure → JWT →
  decryption. *(issue #204)*
- **version sweep** (below) — the original harness that sweeps published client
  versions against a target server.

---

## Version sweep

Sweeps **published** versions of the PostGuard client libraries against a target
server and reports which versions still work — so the breakage boundary is found
before a server change is promoted, and not by a consumer afterwards. It is the
deploy-time backstop for the PR-time wire-compat gate in
[postguard](https://github.com/encryption4all/postguard) (issue #21).

It installs each version of [`@e4a/pg-js`](https://www.npmjs.com/package/@e4a/pg-js)
(npm) and [`E4A.PostGuard`](https://www.nuget.org/packages/E4A.PostGuard) (NuGet)
into an isolated sandbox and runs the legs below against it.

### The support matrix

What the sweep considers supported lives in [`src/matrix.mjs`](src/matrix.mjs),
as data rather than in a workflow's `matrix:` block — the nightly, the
pre-deploy gate and a maintainer sweeping by hand have to sweep the same set:

| Client | Window | Filter |
|---|---|---|
| `@e4a/pg-js` | the newest release of each of the last **two majors** | `majors:2` |
| `E4A.PostGuard` | the newest release of the last major | `majors:1` |

The same file holds the two profiles: `nightly` sweeps the **edge** deployment,
`pre-deploy` sweeps the **candidate** server images (the `stack/` compose, built
from the postguard checkout under test). Both hold both legs mandatory, and the
sweep refuses a `--legs` list that runs fewer than the named profile declares.

### The legs

**`wire`** — the non-interactive server-facing path against the target:

```
fetch params → encrypt (API-key signing) → upload to Cryptify → download + inspect header
```

That is the wire surface a *server* change can break. Signing uses a
PostGuard-for-Business API key (`PG-…`), which is non-interactive.

**`decrypt`** — an **old published SDK opening an artifact the new stack
sealed**. That is the direction that breaks consumers: a deployment updates, its
senders start producing new bytes, and every recipient still on last year's
add-on has to keep opening them.

It needs no server, and it cannot use one: a user secret key only exists after a
Yivi disclosure, and deriving one for a fresh policy needs the PKG's master
secret. So the artifact is sealed at sweep time by the current `@e4a/pg-wasm`
(the layer that owns the container format) into a committed fixture set's key
universe, and each swept version's own decrypt path runs against a stub serving
that set's keys — see [`src/keys.mjs`](src/keys.mjs) and
[`fixtures/README.md`](fixtures/README.md). A pass means the plaintext came back
byte-exact, the header still named the recipient, and the verified sender
survived. Live-server decryption (a real Yivi disclosure against a running
stack) is covered by the yivi-driver's flows in `e2e.yml`, not here.

The published .NET SDK exposes no reader at all, so its `decrypt` leg **asserts
that absence** instead of skipping it, and turns red the day the SDK grows one —
the same way the container corpus asserts `pg-js`'s refusal of memory-mode
containers.

Each version × leg yields one of:

- **pass** — the leg ran and everything it asserts held.
- **fail** with `install=ok` — the interesting case: the version installs but the
  leg breaks. That pinpoints the breakage boundary.
- **install fail** — the published version no longer installs/compiles (e.g. a
  very old release). Reported as such, *not* a false "server broke it".
- **no reader (asserted)** — the recorded absence above.
- **skipped** — no `PG_API_KEY`, or the version no longer installs. Under a
  profile a skip is a **failure**: a leg that quietly did not run is the
  coverage loss the gates exist to catch.
- **no leg** — the version's public API predates every registered adapter, or
  the adapter has no script for that leg (see "Adapters" below).

## Prerequisites

- Node.js ≥ 22 (for the harness and the pg-js sandboxes).
- .NET SDK (for the E4A.PostGuard sandboxes). To *run* the flow you also need the
  matching runtime — the sandbox targets `net8.0`. If `dotnet` isn't installed the
  .NET sweep is skipped, and with .NET in scope both gates then go red on it
  whether or not a profile is named: `notSwept` travels in the report
  unconditionally, because a client that produced no rows is a support window the
  run says nothing about. Under a profile the sweep step itself also exits
  nonzero, and a profile always puts both clients in scope — `--profile nightly
  js` reports the .NET window as unswept rather than as out of scope.
- A PostGuard-for-Business API key (`PG-…`) and a test recipient email, to run the
  actual flow. Without them the harness still enumerates and installs each version.

## Usage

```bash
npm install
cp config.example.env .env   # then edit .env

# Sweep the support matrix the way CI does (nightly | pre-deploy)
npm run sweep -- --profile nightly

# One client, one leg — while working on an adapter
npm run sweep -- js --legs decrypt

# Whatever .env says, no profile (the original manual sweep)
npm run run:all

# Just list what's published, no installing/running
npm run enumerate
```

Then the gates, which are what CI fails on:

```bash
npm run gate -- --legs wire
npm run gate -- --legs decrypt
```

The sweep exits nonzero only when the *harness* could not do its job (a registry
that would not answer, a filter that resolved to nothing, an artifact that would
not seal), so it always gets as far as writing the report. Judging the results is
the gates' job — one per leg, each reading `report/matrix.json`, so a red wire
gate cannot swallow the decrypt verdict.

Configure via `.env` (see `config.example.env`): target URLs (`PG_PKG_URL`,
`PG_CRYPTIFY_URL`), credentials (`PG_API_KEY`, `PG_CITIZEN_EMAIL`,
`PG_ORGANISATION_EMAIL`), the recipient attribute type (`PG_EMAIL_ATTRIBUTE`,
for a deployment issuing test credentials) and which versions to sweep
(`PG_JS_VERSIONS`, `PG_DOTNET_VERSIONS`). Each version filter accepts `all`,
`latest:N`, `majors:N`, a comma list (`1.8.0,1.9.0`), a semver range (`^1.0.0`),
or one exact version (`2.0.0`, or a prerelease like `2.0.0-rc.1` when named
exactly). A profile supplies the matrix and the target; an environment variable
still wins over it, and the report records which value came from where.

Results are written to `report/matrix.md`, `report/matrix.csv` and
`report/matrix.json`.

### In CI

The two profiles exist to be run on a schedule and before a deploy: `nightly`
against edge, `pre-deploy` against the candidate images. The shape a job wants is
one sweep followed by both gates as separate steps, with the second gate under
`if: ${{ !cancelled() }}` — a failed step short-circuits the rest of its job, so
without it the decrypt verdict is invisible on exactly the runs where the wire
leg already went red. The workflow file itself is **not** part of this
directory's tooling and is added separately; until it exists, the profiles are
run by hand as above.

> The `X-POSTGUARD-CLIENT-VERSION` column is what the harness observed the client
> send locally (older versions predating that feature send nothing). The
> authoritative record is always the server's own logs/metrics.

## Adapters

Client APIs drift across major versions, so a single flow script can't drive them
all. Flows live in `src/js/adapters/` and `src/dotnet/adapters/`, one script per
leg, each set registered to a semver range in the corresponding `index.mjs`.
Today there's one `modern` adapter per client targeting the current API. When a
sweep hits older versions that fail to install/compile against the modern flow,
add a new adapter for that range — most-specific first.

## Layout

```
src/
  run.mjs            the sweep (enumerate → seal → sandbox → legs → report)
  gate.mjs           one gate per leg; reads report/matrix.json, exits 1 on a regression
  matrix.mjs         the support matrix + the nightly / pre-deploy profiles
  verdict.mjs        which leg outcomes are a regression (pure)
  enumerate.mjs      published-version listing (npm + NuGet); runnable directly
  filter.mjs         version-filter spec parsing (semver)
  config.mjs         profile + env config, and where each value came from
  keys.mjs           the decrypt legs' key universe + the PKG stub serving it
  seal.mjs           seals the new-stack artifact the decrypt legs open
  report.mjs         writes report/matrix.{md,csv,json}
  spawn.mjs          child-process + result-parsing helpers
  is-main.mjs        entry-point check that survives a symlinked path
  run-js.mjs         per-version sandbox + legs for @e4a/pg-js
  run-dotnet.mjs     per-version sandbox + legs for E4A.PostGuard
  js/adapters/       wire + decrypt flows, range registry (index.mjs)
  js/new-stack/      the sealer run in the new stack's own sandbox
  dotnet/adapters/   modern/Program.cs, modern/DecryptProbe.cs, index.mjs
.sandbox/            throwaway per-version installs (gitignored)
report/              generated reports (gitignored)
```

## Development

Each part has its own README with build/run instructions:

- [`stack/`](stack/) — the local services (`docker compose up -d`).
- [`yivi-driver/`](yivi-driver/) — the headless holder + e2e tests. Note its
  prerequisites (CGO + SQLCipher).
- Version sweep — `npm install`, then `npm run run:all` (see above).

## License

MIT — part of the [PostGuard](https://postguard.eu) project.
