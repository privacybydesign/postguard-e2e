## Agent notes (migrated from the dobby memory repo)

### yivi-driver: local build/test is blocked in the workspace
The `yivi-driver/` module (headless Yivi holder) builds on irmago's `client.Client`. Three things block building or running it in the Coder workspace:
- **Native sqlcipher (cgo).** `client.New` unconditionally imports a storage package that pulls in sqlcipher (no build tag to opt out), so `go build`/`go run`/`go test` fail at compile with a "package sqlcipher was not found in the pkg-config search path" error. It needs `libsqlcipher-dev`, which the workspace can't install (no root). Same cgo-sqlcipher wall as irmamobile's local tests.
- **Go 1.26.** irmago master and `yivi-driver/go.mod` both declare `go 1.26.0`. The workspace ships an older Go; `GOTOOLCHAIN=auto` auto-downloads 1.26 fine, but `GOTOOLCHAIN=local` errors.
- **Docker daemon unavailable**, so the docker-compose stack (PKG + irma-server + cryptify + mailcrab) can't be brought up, meaning the disclosure-flow integration test only ever skips locally.

For any postguard-e2e / yivi-driver review, expect tests to be SKIPPED locally: do static review, gofmt, and import-chain checks, and defer runtime verification to CI. CI must install `libsqlcipher-dev` and use Go 1.26. irmago master already carries the `client.New` signature and the packages the driver imports, so a pinned published irmago release (rather than the local `../../irmago` replace) is viable once tagged.

### compat/: the manifest is edited as text, not reserialised
`compat/manifest.json` writes each `sdk[*]` entry on one line. `bump-manifest.mjs` (run unattended by a scheduled job) patches the version string in place so its PRs are a one-line diff. Do not run a formatter over the manifest and do not "tidy" the bumper into `JSON.parse` + `JSON.stringify`: a round-trip turns every one-line entry into four and buries the actual change. `bump-manifest.test.mjs` asserts the one-line property and reads its expected versions out of the manifest, so it survives its own bumps.

`compat/` is the one part of this repo that runs fully in the workspace (`npm ci && npm test && npm run check`), but the check reaches npm, NuGet and the GitHub contents API, so it needs network and a `GH_TOKEN` for the rate limit.
