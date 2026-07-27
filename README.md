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

A manual test harness that sweeps **published** versions of the PostGuard client
libraries against a target server and reports which versions still work — so you
can find the breakage boundary before promoting a server change to production.

It installs each published version of [`@e4a/pg-js`](https://www.npmjs.com/package/@e4a/pg-js)
(npm) and [`E4A.PostGuard`](https://www.nuget.org/packages/E4A.PostGuard) (NuGet)
into an isolated sandbox, runs the non-interactive server-facing flow against the
configured PKG + Cryptify, and writes a pass/fail matrix.

## What it tests (and what it doesn't)

For each version it runs:

```
fetch params → encrypt (API-key signing) → upload to Cryptify → download + inspect header
```

This is exactly the wire surface a server change can break. It does **not**
attempt decryption — retrieving a User Secret Key needs an interactive Yivi (QR)
session, which can't be automated. Signing uses a PostGuard-for-Business API key
(`PG-…`), which is non-interactive.

Each version yields one of:

- **install ok / run pass** — the version works against this target.
- **install ok / run fail** — installs, but the flow breaks against this target
  (the interesting case — this is the breakage boundary).
- **install fail** — the published version no longer installs/compiles (e.g. a
  very old release). Reported as such, *not* a false "server broke it".
- **run skipped (no API key)** — no `PG_API_KEY` set; only installability tested.
- **no adapter** — the version's public API predates every registered flow
  adapter (see "Adapters" below).

## Prerequisites

- Node.js ≥ 22 (for the harness and the pg-js sandboxes).
- .NET SDK (for the E4A.PostGuard sandboxes). To *run* the flow you also need the
  matching runtime — the sandbox targets `net8.0`. If `dotnet` isn't installed the
  .NET sweep is skipped automatically.
- A PostGuard-for-Business API key (`PG-…`) and a test recipient email, to run the
  actual flow. Without them the harness still enumerates and installs each version.

## Usage

```bash
npm install
cp config.example.env .env   # then edit .env

# Sweep both clients (or run:js / run:dotnet)
npm run run:all

# Just list what's published, no installing/running
npm run enumerate
```

Configure via `.env` (see `config.example.env`): target URLs (`PG_PKG_URL`,
`PG_CRYPTIFY_URL`), credentials (`PG_API_KEY`, `PG_CITIZEN_EMAIL`,
`PG_ORGANISATION_EMAIL`), and which versions to sweep (`PG_JS_VERSIONS`,
`PG_DOTNET_VERSIONS`). Each version filter accepts `all`, `latest:N`, a comma
list (`1.8.0,1.9.0`), a semver range (`^1.0.0`), or one exact version
(`2.0.0`, or a prerelease like `2.0.0-rc.1` when named exactly). Start narrow
(`latest:5`).

Results are written to `report/matrix.md` and `report/matrix.csv`.

> The `X-POSTGUARD-CLIENT-VERSION` column is what the harness observed the client
> send locally (older versions predating that feature send nothing). The
> authoritative record is always the server's own logs/metrics.

## Adapters

Client APIs drift across major versions, so a single flow script can't drive them
all. Flows live in `src/js/adapters/` and `src/dotnet/adapters/`, each registered
to a semver range in the corresponding `index.mjs`. Today there's one `modern`
adapter per client targeting the current API. When a sweep hits older versions
that fail to install/compile against the modern flow, add a new adapter for that
range — most-specific first.

## Layout

```
src/
  run.mjs            orchestrator (enumerate → sandbox → run → report)
  enumerate.mjs      published-version listing (npm + NuGet); runnable directly
  filter.mjs         version-filter spec parsing (semver)
  config.mjs         env-driven config
  report.mjs         writes report/matrix.{md,csv}
  spawn.mjs          child-process + result-parsing helpers
  run-js.mjs         per-version sandbox + flow for @e4a/pg-js
  run-dotnet.mjs     per-version sandbox + flow for E4A.PostGuard
  js/adapters/       modern.mjs flow + range registry (index.mjs)
  dotnet/adapters/   modern/Program.cs flow + range registry (index.mjs)
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
