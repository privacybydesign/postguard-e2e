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

`compat/` runs fully in the workspace (`npm ci && npm test && npm run check`), but the check reaches npm, NuGet and the GitHub contents API, so it needs network and a `GH_TOKEN` for the rate limit. To rehearse a registry answer you cannot publish (a prerelease on `latest`, a 404), write a throwaway file that reassigns `globalThis.fetch` and load it with `node --import /tmp/stub.mjs bump-manifest.mjs`. Nothing like it is committed; both scripts call `fetch` directly, so that hook is the whole seam.

### compat/: the bumper edits fixtures/ too, and the job must commit it
`sdk["pg-js"].current` is read twice: by the drift check, and by `fixtures/readers.mjs`, which verifies the container corpus with that exact `@e4a/pg-js` and throws when the installed version disagrees. So `bump-manifest.mjs` moves `fixtures/package.json`'s pin and reconciles `fixtures/package-lock.json` (via `npm install --package-lock-only`, because only the registry can supply the integrity hash) in the same run — the `COUPLED_PINS` table says which pins follow the manifest. `fixtures`' `@e4a/pg-wasm` is deliberately not one: that pin is meant to age against the corpus.

Two consequences. A bump PR touches three files, so `compat-bump.yml`'s `git diff --quiet`/`git commit` path has to list all three — a path-limited commit naming only the manifest silently drops the pin and hands back the red PR this was fixing. Both now read one `paths=(compat/manifest.json fixtures/package.json fixtures/package-lock.json)` array, so a pin added to `COUPLED_PINS` has to be added there too; the App has no `workflows` permission, so that edit cannot ride along with the bumper's and a maintainer applies it by hand. And the pins are written BEFORE the manifest: a failure then leaves `current` where it was, so the next run plans the same bump and retries. The other order strands the tree, because a run that finds `current` already at latest plans no bumps and never revisits the pin.

### fixtures/: the corpus job's JS half runs in the workspace
`cd fixtures && npm ci && npm test && npm run ledger && npm run verify` all pass locally (network for the install only, no Docker, ~1 min) — that is the whole `crypto-fixtures` gate except `npm run append-only` (needs a merge base, so a real git repo) and `fixtures-verify`'s `cargo run` (needs `encryption4all/postguard` checked out as a sibling for the pg-core path dep). To rehearse a bump end-to-end, copy the tree with `git archive`, set the manifest + pin one published version back, run the bumper, then run those four commands: the bumper's output tree is what CI grades, and a 2.3.4 → 2.3.3 → 2.3.4 round trip reproduces the committed lockfile byte for byte.

### compat/: an sdkConsumers entry can be a version range or a workspace link
Two of the three SDK consumers are now apps inside the `encryption4all/postguard-js` monorepo, so their `repo`/`manifest` point there (`apps/website/package.json`, `apps/tb-addon/package.json`) and they carry `"expect": "workspace"`. Their old standalone repos are archived/stale: reading a frozen file is a permanent silent-green in a drift detector, which is what issue #30 was. For those entries the check asserts the dep is still a `workspace:` link, not which version a range resolves — a `workspace:*` dep cannot drift, so the pin is the regression. `consumerVerdict` in `check-versions.mjs` holds both modes plus the knownDrift ratchet, and it is pure, so consumer behaviour is testable without network; keep new consumer rules there rather than in `main()`. An unknown `expect` value is a problem, not a silent fall-through to the version path.

A GitHub read that 404s is a problem for both the npm and the Rust consumer path (`readFailureMessage`), so a moved file fails loudly. To rehearse either failure without touching a real repo, stub `globalThis.fetch` and run `node --import /tmp/stub.mjs check-versions.mjs`, or copy `compat/` to a temp dir and edit the manifest copy — the script reads `manifest.json` next to itself.

### compat/: which mismatches the bumper will act on lives in one place
`classifyEntry` in `bump-manifest.mjs` decides, per `sdk` entry, whether a mismatch is a bump, a skip, or nothing. `check-versions.mjs` calls it before it tells a reader to run `npm run bump`. Keep it that way: when the two disagreed, a prerelease on npm's `latest` dist-tag made the nightly red with an instruction the bumper refused, so the red could never clear. Any new rule about what the bump may touch goes in `classifyEntry`, not in either caller.

### Workflow `run:` blocks that pipe must set pipefail themselves
A `run:` block with no `shell:` key runs under `bash -e {0}`, which has no `pipefail`, so a piped command's failure is discarded and the step passes. Only an explicit `shell: bash` gets `-eo pipefail`. The `go test ... | tee test.out` step in `e2e.yml` sets `set -o pipefail` for exactly this reason; keep doing that (or avoid the pipe) in any step whose exit status matters.

### src/ tests are not run by CI
`e2e.yml` only triggers on `pull_request` for `yivi-driver/**`, `stack/**`, `fixtures/**`, `fixtures-verify/**`, `contracts/**`, `compat/**`. Changes under `src/**` (the version-matrix driver: `filter.mjs`, `run*.mjs`, etc.) run no CI job, so `src/*.test.mjs` files are not exercised on PRs. Run them locally with `node --test 'src/**/*.test.mjs'`. Pass files or a quoted glob, not a directory: on Node 22 the runner treats `node --test src` as a module to import and dies with `MODULE_NOT_FOUND`. That is also why `compat/`'s script is a bare `node --test`, which scans the cwd because it has no positional. Wiring `src/` into CI needs a workflow edit (the App lacks `workflows` permission), so `version-sweep.yml` is handed over as a patch in a PR comment; until a maintainer applies it, nothing under `src/` runs in CI, including the sweep's own gates.

In a `workflow_call` job the `github` context is the **caller's**: `github.event_name` is whatever triggered the calling pipeline, so a job gated on `github.event_name != 'pull_request'` is skipped when a `pull_request`-triggered deploy pipeline calls it — and the reusable workflow reports green having run nothing. Gate on the `inputs` context instead (non-empty only for `workflow_call`/`workflow_dispatch`). The same applies to `actions/checkout`, which clones the caller's repo unless `repository:` is given; and this repo is private, so a caller outside it must pass a token that can read it.

`src/keys.mjs` imports `fixtureSets`/`loadSet` from `fixtures/corpus.mjs` across the package boundary. That resolves because `corpus.mjs` imports only node builtins, and it is deliberate: what a fixture set is has one owner, and a second opinion in `src/` would be a disagreement nobody sees until a set silently stops being swept.

### src/: the decrypt legs seal into a fixture key universe, and why they must
A user secret key only exists after a Yivi disclosure, and deriving one for a fresh policy needs the PKG's master SECRET key — so "seal now, open with an old SDK" cannot be aimed at a deployment the harness cannot disclose to. `src/keys.mjs` therefore seals into a committed fixture set's key universe (`mpk.json` + `signkey.json` in, `usk.json` + `vk.json` proving it opens) and serves those two files from a loopback stub, which is what lets a published SDK's real decrypt path run unmodified. The policy timestamp must be the SET's (`meta.ts`): the committed USK is derived over the policy including it, so a clock there produces an artifact nothing in the universe can open. Only sets carrying `signkey.json` are sealable — `pg-wasm-0.6.1/` came from the live stack and has none.

Sealing is `@e4a/pg-wasm`, never `@e4a/pg-js`: pg-js addresses recipients by email and stamps the policy with the current time, so it cannot seal into an existing universe. `yivi-driver/oracle/oracle.mjs` is the other consumer of the same raw `sealStream(mpk, {policy, pubSignKey}, …)` shape — check both when that API moves.

Two things that cost a debugging round here. `pg-js`'s `sender` shape differs by major (1.x returns the raw policy, 2.x nests it under `public`), so a sender check that reads one shape false-reds the other major. And a harness that serves the stub must not use `spawnSync` for the child that talks to it: the blocked event loop never answers, and every case "hangs".

### src/: a gate judges rows, so an absent client is the coverage hole to close
`legVerdict` filters the rows in `report/matrix.json`, so a client that produced NO row is invisible to it: the pg-js rows populate the leg and certify it on behalf of a client nobody swept, and both gates go green over half the declared support matrix. Two separate routes reach that state and each needed its own fix — no `dotnet` on the machine that ran the sweep, and a narrowing positional (`sweep --profile nightly js`). Hence `notSwept` travelling in the report, and `coverageScope(which, profile)`: under a profile the coverage question is the whole `SUPPORT_MATRIX`, because a profile is a claim about a support window rather than a request to sweep something, while a bare `sweep -- js` narrows legitimately. Before trusting a green gate after adding a client or a leg, ask what an EMPTY result for it looks like to `legVerdict`.

### The published .NET SDK has no reader, and no attribute-type override either
`E4A.PostGuard` 0.6.0 exports `Encrypt`, `UploadAsync` and `ToBytesAsync` and nothing that opens a container (reflection over the assembly is how to check). Its decrypt leg is therefore a probe that ASSERTS the absence and goes red when a read-side member appears (`src/dotnet/adapters/modern/DecryptProbe.cs`), rather than a skip. Building the sandbox needs only the SDK, but running it needs the .NET 8 runtime — a machine with only .NET 10 installed builds fine and fails at `dotnet run` with "You must install or update .NET".

The same reflection answers the other recurring question: `PG_EMAIL_ATTRIBUTE` cannot reach the .NET wire leg. `PostGuardConfig` carries only `PkgUrl`, `CryptifyUrl`, `Headers`, `AllowInsecureUrls`, `HttpClient` and `Timeout`, and `Recipient.Email(string)` takes the address alone; `RecipientBuilder.ExtraAttribute(k, v)` adds a conjunct to the policy rather than replacing the email type, so it is not a workaround. Under `pre-deploy`, whose whole point is the demo attribute type, the .NET rows still address the production types — a red there is this harness's limit, not an SDK regression. To re-check after an SDK release: `dotnet new console --framework net10.0`, `dotnet add package E4A.PostGuard --version <v>`, and reflect over those types; the SDK alone is enough, no `net8.0` runtime needed.

### Runnable scripts under src/ use isMain(), not the file:// idiom
`import.meta.url === `file://${process.argv[1]}`` compares an unresolved URL against a symlink-resolved path. On macOS `os.tmpdir()` is a symlink (`/var/folders` -> `/private/var/folders`), so a script spawned from a temp directory decides it is not the entry point, runs nothing and exits 0 — a test that spawns a runner sees a silent success. `src/is-main.mjs` compares realpaths; its test builds the symlinked directory explicitly so the case is covered on Linux too.

`compat/` is its own npm package with its own `semver`; `src/` is part of the root `postguard-version-matrix` package. Importing across the two does work (the root declares `semver` as well), so the reason not to share a helper here is policy, not resolution. `compat/registries.mjs`'s `highestStable()` and `filter.mjs`'s `latest:N` both pick highest-stable-first, but they answer different questions. The manifest tracks what consumers should run, so it never takes a prerelease; the matrix picks which published builds to sweep, and takes a prerelease when you name one. Keep the two prerelease policies apart rather than folding them into one helper.
