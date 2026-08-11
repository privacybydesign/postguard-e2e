## Agent notes (migrated from the dobby memory repo)

### yivi-driver: what does and does not run locally
The `yivi-driver/` module (headless Yivi holder) builds on irmago's `client.Client`, which needs cgo + native sqlcipher. The workspace now ships `libsqlcipher-dev` (`pkg-config --modversion sqlcipher` answers 4.5), so `go build`, `go vet`, `go run .` and `go test` all work — check that before assuming the old "cannot build here" story. Two things still apply:
- **Go 1.26.** irmago master and `yivi-driver/go.mod` both declare `go 1.26.0`, and the workspace ships an older Go. `GOTOOLCHAIN=auto` auto-downloads 1.26 (needs network on the first build); `GOTOOLCHAIN=local` errors.
- **Docker daemon unavailable**, so the docker-compose stack (PKG + irma-server + cryptify + mailcrab) can't be brought up. Every stack-based test — `TestGoldenFlow`, `TestRealSdkGoldenFlow`, `TestPKGInitiatedDisclosureYieldsJWT`, `TestEmailRecipientRoundTrip`, `TestLiveContract` — SKIPS locally, and only CI can verify them.

Two flows need no stack at all and are the local signal worth having: `go run .` (the in-process self-test) and `TestKeyshareDisclosureFlow`. Both want an irmago checkout, defaulting to `../../irmago` (`IRMAGO_ROOT`) to match go.mod's `replace`; clone it at the ref `.github/workflows/e2e.yml` pins, or a driver change will be verified against a different irmago than CI uses. irmago master already carries the `client.New` signature and the packages the driver imports, so a pinned published irmago release (rather than the local replace) is viable once tagged.

### yivi-driver: `-race` reports an irmago bug, not ours
`go test -race` on any flow that holds a client open for a few seconds after an issuance reports a data race inside irmago: the revocation job `client.New` schedules (`irma/irmaclient/revocation.go:48-49`, run by gocron) reads client state that `IrmaClient.addCredential` (`irmaclient.go:336`) writes. Both sides of the race are irmago frames; no yivi-driver code appears in either stack. It reproduces on a plain `irma-demo` issuance with no keyshare involved, so it is not specific to any one flow — it just needs the process to live long enough for the cron tick to land, which the fast flows never do. `e2e.yml` runs `go test` without `-race`, so it does not redden CI. Worth reporting upstream; do not chase it as a harness bug.

### yivi-driver: irmago's test-only helpers are in internal/, so they get reimplemented here
The pieces of irmago that make a headless holder testable — its test signer, and `testkeyshare.StartKeyshareServer` — live under `irmago/internal/`, which the Go toolchain refuses to let another module import. `signer.go` and `keyshare.go` are therefore local reimplementations on top of irmago's *public* packages (`irmaclient.Signer`, `keyshareserver`). Do not "simplify" either into an import of the irmago helper; it does not compile. When irmago's pinned ref moves, these two are where an upstream signature change lands.

### yivi-driver: a keyshare session only asks for a PIN once the token ages out
irmaclient caches the keyshare server's PIN-authentication JWT and reuses it, treating a token that expires within the next *minute* as already gone (`tokenValid`'s hard-coded leeway). So with a keyshare server configured the way irmago's own tests configure it, back-to-back sessions after enrollment never prompt for a PIN — the PIN branch is simply not reached, and a test asserting it silently passes on the wrong path. `TestKeyshareDisclosureFlow` gets at it by setting the server's pin expiry just above that leeway and waiting the difference out before disclosing. The expiry cannot go *below* the leeway: enrollment validates the token it was just handed, so the holder would reject its own enrollment.

### stack/business-db: the schema is postguard-business's, not ours
`business-db` is provisioned from postguard-business's real `drizzle/migrations`
(fetched at `up` time into a volume by `business-schema-source`, applied by
`business-migrate`). `seed-data.sql` is DATA ONLY — never add DDL to it. Adding a
column there to make something work means the harness has started asserting
against its own fixture again, which is the exact regression postguard#237 was
about; the change belongs in postguard-business.

`provision.sh` takes migration ORDER from `meta/_journal.json`, not from a
filename sort, and fails if the journal and the `.sql` files disagree. It applies
each file with plain `psql -f` (no `--single-transaction`): postguard-business's
own migration-safety checker pushes new migrations towards
`CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block.

`business-db` runs `postgres:16-alpine` while postguard-business runs `postgres:18`,
so a migration using an 18-only feature would fail here and nowhere else. If that
ever happens the fix is to match its major version, not to patch around it.

Provisioning is a one-shot container, not a `/docker-entrypoint-initdb.d` script:
initdb scripts only fire on an empty data dir and the postgres image keeps an
anonymous volume, so the old init-script seed silently stopped re-applying after
the first `up`. The one-shot drops and rebuilds the schema every time instead.

You can rehearse the whole thing without Docker: the workspace has no daemon, but
a zonky embedded-postgres tarball plus a `psql` extracted from a pgdg
`postgresql-client-16` .deb gives a real server and a real client, and the two
scripts run as-is against it (`PGB_MIGRATIONS_DIR` / `PGB_DEST` / `PGHOST`…).

### compat/: the manifest is edited as text, not reserialised
`compat/manifest.json` writes each `sdk[*]` entry on one line. `bump-manifest.mjs` (run unattended by a scheduled job) patches the version string in place so its PRs are a one-line diff. Do not run a formatter over the manifest and do not "tidy" the bumper into `JSON.parse` + `JSON.stringify`: a round-trip turns every one-line entry into four and buries the actual change. `bump-manifest.test.mjs` asserts the one-line property and reads its expected versions out of the manifest, so it survives its own bumps.

`compat/` is the one part of this repo that runs fully in the workspace (`npm ci && npm test && npm run check`), but the check reaches npm, NuGet and the GitHub contents API, so it needs network and a `GH_TOKEN` for the rate limit. To rehearse a registry answer you cannot publish (a prerelease on `latest`, a 404), write a throwaway file that reassigns `globalThis.fetch` and load it with `node --import /tmp/stub.mjs bump-manifest.mjs`. Nothing like it is committed; both scripts call `fetch` directly, so that hook is the whole seam.

### compat/: an sdkConsumers entry can be a version range or a workspace link
Two of the three SDK consumers are now apps inside the `encryption4all/postguard-js` monorepo, so their `repo`/`manifest` point there (`apps/website/package.json`, `apps/tb-addon/package.json`) and they carry `"expect": "workspace"`. Their old standalone repos are archived/stale: reading a frozen file is a permanent silent-green in a drift detector, which is what issue #30 was. For those entries the check asserts the dep is still a `workspace:` link, not which version a range resolves — a `workspace:*` dep cannot drift, so the pin is the regression. `consumerVerdict` in `check-versions.mjs` holds both modes plus the knownDrift ratchet, and it is pure, so consumer behaviour is testable without network; keep new consumer rules there rather than in `main()`. An unknown `expect` value is a problem, not a silent fall-through to the version path.

A GitHub read that 404s is a problem for both the npm and the Rust consumer path (`readFailureMessage`), so a moved file fails loudly. To rehearse either failure without touching a real repo, stub `globalThis.fetch` and run `node --import /tmp/stub.mjs check-versions.mjs`, or copy `compat/` to a temp dir and edit the manifest copy — the script reads `manifest.json` next to itself.

### compat/: which mismatches the bumper will act on lives in one place
`classifyEntry` in `bump-manifest.mjs` decides, per `sdk` entry, whether a mismatch is a bump, a skip, or nothing. `check-versions.mjs` calls it before it tells a reader to run `npm run bump`. Keep it that way: when the two disagreed, a prerelease on npm's `latest` dist-tag made the nightly red with an instruction the bumper refused, so the red could never clear. Any new rule about what the bump may touch goes in `classifyEntry`, not in either caller.

### Workflow `run:` blocks that pipe must set pipefail themselves
A `run:` block with no `shell:` key runs under `bash -e {0}`, which has no `pipefail`, so a piped command's failure is discarded and the step passes. Only an explicit `shell: bash` gets `-eo pipefail`. The `go test ... | tee test.out` step in `e2e.yml` sets `set -o pipefail` for exactly this reason; keep doing that (or avoid the pipe) in any step whose exit status matters.

### src/ tests are not run by CI
`e2e.yml` only triggers on `pull_request` for `yivi-driver/**`, `stack/**`, `fixtures/**`, `fixtures-verify/**`, `contracts/**`, `compat/**`. Changes under `src/**` (the version-matrix driver: `filter.mjs`, `run*.mjs`, etc.) run no CI job, so `src/*.test.mjs` files are not exercised on PRs. Run them locally with `node --test 'src/**/*.test.mjs'`. Pass files or a quoted glob, not a directory: on Node 22 the runner treats `node --test src` as a module to import and dies with `MODULE_NOT_FOUND`. That is also why `compat/`'s script is a bare `node --test`, which scans the cwd because it has no positional. Wiring `src/` into CI needs a workflow edit (the App lacks `workflows` permission).

`compat/` is its own npm package with its own `semver`; `src/` is part of the root `postguard-version-matrix` package. Importing across the two does work (the root declares `semver` as well), so the reason not to share a helper here is policy, not resolution. `compat/registries.mjs`'s `highestStable()` and `filter.mjs`'s `latest:N` both pick highest-stable-first, but they answer different questions. The manifest tracks what consumers should run, so it never takes a prerelease; the matrix picks which published builds to sweep, and takes a prerelease when you name one. Keep the two prerelease policies apart rather than folding them into one helper.
