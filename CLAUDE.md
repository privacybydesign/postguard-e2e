
---

## Agent notes (migrated from the dobby memory repo)

## yivi-driver: local build/test is blocked in the workspace
The `yivi-driver/` module (headless Yivi holder) builds on irmago's `client.Client`. Three things block building or running it in the Coder workspace:
- **Native sqlcipher (cgo).** `client.New` unconditionally imports a storage package that pulls in sqlcipher (no build tag to opt out), so `go build`/`go run`/`go test` fail at compile with a "package sqlcipher was not found in the pkg-config search path" error. It needs `libsqlcipher-dev`, which the workspace can't install (no root). Same cgo-sqlcipher wall as irmamobile's local tests.
- **Go 1.26.** irmago master and `yivi-driver/go.mod` both declare `go 1.26.0`. The workspace ships an older Go; `GOTOOLCHAIN=auto` auto-downloads 1.26 fine, but `GOTOOLCHAIN=local` errors.
- **Docker daemon unavailable**, so the docker-compose stack (PKG + irma-server + cryptify + mailcrab) can't be brought up, meaning the disclosure-flow integration test only ever skips locally.

For any postguard-e2e / yivi-driver review, expect tests to be SKIPPED locally: do static review, gofmt, and import-chain checks, and defer runtime verification to CI. CI must install `libsqlcipher-dev` and use Go 1.26. irmago master already carries the `client.New` signature and the packages the driver imports, so a pinned published irmago release (rather than the local `../../irmago` replace) is viable once tagged.
