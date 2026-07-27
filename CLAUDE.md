## Agent notes (migrated from the dobby memory repo)

### yivi-driver: local build/test is blocked in the workspace
The `yivi-driver/` module (headless Yivi holder) builds on irmago's `client.Client`. Three things block building or running it in the Coder workspace:
- **Native sqlcipher (cgo).** `client.New` unconditionally imports a storage package that pulls in sqlcipher (no build tag to opt out), so `go build`/`go run`/`go test` fail at compile with a "package sqlcipher was not found in the pkg-config search path" error. It needs `libsqlcipher-dev`, which the workspace can't install (no root). Same cgo-sqlcipher wall as irmamobile's local tests.
- **Go 1.26.** irmago master and `yivi-driver/go.mod` both declare `go 1.26.0`. The workspace ships an older Go; `GOTOOLCHAIN=auto` auto-downloads 1.26 fine, but `GOTOOLCHAIN=local` errors.
- **Docker daemon unavailable**, so the docker-compose stack (PKG + irma-server + cryptify + mailcrab) can't be brought up, meaning the disclosure-flow integration test only ever skips locally.

For any postguard-e2e / yivi-driver review, expect tests to be SKIPPED locally: do static review, gofmt, and import-chain checks, and defer runtime verification to CI. CI must install `libsqlcipher-dev` and use Go 1.26. irmago master already carries the `client.New` signature and the packages the driver imports, so a pinned published irmago release (rather than the local `../../irmago` replace) is viable once tagged.

### compat/: the manifest is edited as text, not reserialised
`compat/manifest.json` writes each `sdk[*]` entry on one line. `bump-manifest.mjs` (run unattended by a scheduled job) patches the version string in place so its PRs are a one-line diff. Do not run a formatter over the manifest and do not "tidy" the bumper into `JSON.parse` + `JSON.stringify`: a round-trip turns every one-line entry into four and buries the actual change. `bump-manifest.test.mjs` asserts the one-line property and reads its expected versions out of the manifest, so it survives its own bumps.

`compat/` is the one part of this repo that runs fully in the workspace (`npm ci && npm test && npm run check`), but the check reaches npm, NuGet and the GitHub contents API, so it needs network and a `GH_TOKEN` for the rate limit. To rehearse a registry answer you cannot publish (a prerelease on `latest`, a 404), write a throwaway file that reassigns `globalThis.fetch` and load it with `node --import /tmp/stub.mjs bump-manifest.mjs`. Nothing like it is committed; both scripts call `fetch` directly, so that hook is the whole seam.

### compat/: which mismatches the bumper will act on lives in one place
`classifyEntry` in `bump-manifest.mjs` decides, per `sdk` entry, whether a mismatch is a bump, a skip, or nothing. `check-versions.mjs` calls it before it tells a reader to run `npm run bump`. Keep it that way: when the two disagreed, a prerelease on npm's `latest` dist-tag made the nightly red with an instruction the bumper refused, so the red could never clear. Any new rule about what the bump may touch goes in `classifyEntry`, not in either caller.

### Workflow `run:` blocks that pipe must set pipefail themselves
A `run:` block with no `shell:` key runs under `bash -e {0}`, which has no `pipefail`, so a piped command's failure is discarded and the step passes. Only an explicit `shell: bash` gets `-eo pipefail`. The `go test ... | tee test.out` step in `e2e.yml` sets `set -o pipefail` for exactly this reason; keep doing that (or avoid the pipe) in any step whose exit status matters.

### src/ tests are not run by CI
`e2e.yml` only triggers on `pull_request` for `yivi-driver/**`, `stack/**`, `fixtures/**`, `fixtures-verify/**`, `contracts/**`, `compat/**`. Changes under `src/**` (the version-matrix driver: `filter.mjs`, `run*.mjs`, etc.) run no CI job, so `src/*.test.mjs` files are not exercised on PRs. Run them locally with `node --test 'src/**/*.test.mjs'`. Pass files or a quoted glob, not a directory: on Node 22 the runner treats `node --test src` as a module to import and dies with `MODULE_NOT_FOUND`. That is also why `compat/`'s script is a bare `node --test`, which scans the cwd because it has no positional. Wiring `src/` into CI needs a workflow edit (the App lacks `workflows` permission).

`compat/` is its own npm package with its own `semver`; `src/` is part of the root `postguard-version-matrix` package. Importing across the two does work (the root declares `semver` as well), so the reason not to share a helper here is policy, not resolution. `compat/registries.mjs`'s `highestStable()` and `filter.mjs`'s `latest:N` both pick highest-stable-first, but they answer different questions. The manifest tracks what consumers should run, so it never takes a prerelease; the matrix picks which published builds to sweep, and takes a prerelease when you name one. Keep the two prerelease policies apart rather than folding them into one helper.
