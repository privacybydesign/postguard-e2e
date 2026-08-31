# Compat manifest — cross-repo version drift detector

EPIC #201, **Phase 3 (kill version drift)**. PostGuard spans ~12 repos bound by
a handful of shared components (the `@e4a/pg-*` SDK line, the Rust IRMA library).
When one repo bumps a shared component and another lags, you get the EPIC's
signature failure: *"fix one thing, three others break"* — found late, by hand.

`manifest.json` is the **single source of truth** for the known-good version
set. `check-versions.mjs` reads the versions each repo *actually* declares
(npm registry + GitHub) and compares them, so drift is caught in CI instead of
in production.

## What it checks

- **SDK producers** — `manifest.sdk[*].current` must equal what the registry
  serves (npm for the `@e4a/pg-*` line, NuGet for `E4A.PostGuard`), so the
  manifest can't go stale.
- **SDK consumers** — an external repo's declared `@e4a/pg-js` range must
  resolve the current published version (`semver.satisfies`).
- **Monorepo members** — an entry marked `"expect": "workspace"` lives in
  `encryption4all/postguard-js`. Its dep is a `workspace:` link, which cannot
  drift, so the range question is meaningless; the check asserts the link is
  *still* there. A member that regresses to a fixed pin
  (`"@e4a/pg-js": "2.3.4"`) reintroduces exactly the drift the consolidation
  removed, and that is what gets reported.
- **The paths themselves** — a `repo`/`manifest` GitHub read that 404s is a hard
  failure, not a skip. An entry whose file no longer exists is monitoring
  nothing, so a move has to be followed here rather than reporting green forever.
- **Rust IRMA library** — consumers must use the canonical crate (`irmars`) at
  the current version, not the legacy `irma` crate.

## The ratchet

Existing drift is not a hard failure — it's recorded in a `knownDrift` block
with a tracking issue, so CI stays green while the drift is worked off. But the
check fails if:

1. **New** drift appears that isn't allowlisted, or
2. a `knownDrift` entry has since been **fixed** (forcing the allowlist to be
   cleaned up, so it can't rot).

You cannot introduce new drift silently, and you cannot leave stale exceptions.

## Known drift (tracked)

| Repo | Component | Drift | Issue |
|---|---|---|---|
| postguard-outlook-addon | `@e4a/pg-js` | pins `^1.10.0`, a major behind `2.x` | encryption4all/postguard-outlook-addon#125 |

## The auto-bump

A producer publishing a new version turns the check red, and only an edit to
this manifest clears it. Once that took four days, and a nightly nobody can act
on stops being read.

So a scheduled job runs `bump-manifest.mjs`. It moves each `sdk[*].current` up
to the published latest and opens a PR with the result. Consumer ranges and the
`knownDrift` ratchet stay as they are, so what is still red after the bump is
real drift in another repo.

`sdk["pg-js"].current` is not read only here. `fixtures/readers.mjs` verifies
the archival container corpus with exactly that version of `@e4a/pg-js` and
refuses to run when the installed one disagrees, so a bump that moved the
manifest alone opened a PR the corpus job failed and nothing in the tree could
clear. The bumper therefore moves `fixtures/package.json`'s pin in the same run
and reconciles `fixtures/package-lock.json` with `npm install
--package-lock-only`, and a bump PR touches three files instead of one.

Which pins follow the manifest is the `COUPLED_PINS` table in
`bump-manifest.mjs`. `fixtures`' `@e4a/pg-wasm` is deliberately absent: it is
pinned published as the client half of the read-forever contract and is meant to
age against the corpus.

The bump only ratchets forward. A prerelease, a version the registry serves
that semver can't parse, or a latest older than `current` (an unpublished
release) is reported and skipped, never applied. `check-versions.mjs` asks the
bumper about each of those before it points a reader at `npm run bump`: a
prerelease on the `latest` dist-tag is a note there rather than a red, and the
rest say what actually needs doing instead of naming a bump that won't run.

```bash
cd compat && npm run bump              # rewrite manifest.json + the coupled pins
cd compat && npm run bump -- --dry-run # report only
```

Bumps go to stdout as `pkg: from -> to`, one per line, for the PR body, followed
by a line per coupled pin the run carried along; status and skips go to stderr.
Nothing to bump means no output and no rewrite.

The Rust `irmaLib.current` is not auto-bumped: the crates.io lookup added for
the reader-row watch below is not wired into `registryOf`, and that version
moves with a deliberate migration rather than a release.

## The reader-row watch

`check-reader-rows.mjs` asks a different question, about a different repo:
`COMPATIBILITY.md` in `encryption4all/postguard` carries a fenced block of
reader rows — the highest published patch of each line in the support window —
and the compat gates there install exactly those versions. A producer
publishing a new patch makes a row stale, and nothing in `postguard` notices,
since it has no scheduled workflow.

```bash
cd compat && npm run check-readers
```

Highest *in line*, not highest overall: with `pg-core` 0.6.5 published, the row
pinning 0.5.10 is current, because 0.5 is a supported line of its own. A row
whose registry has no backend, or whose lookup fails, is a problem rather than a
skip — a check that quietly stops watching a package reports green forever.

It stays a separate entry point from `check-versions.mjs` on purpose. "The
reader rows are stale" and "a consumer repo drifted" are statements about
different repos, and folding them into one exit code lets either mask the other.

## Run it

```bash
cd compat && npm ci && npm test && npm run check
cd compat && npm run check-readers   # red today: a reader row in postguard is stale
# Two commands, not one chain: `&&` would let a red `check` hide the reader-row
# verdict, which is the masking the section above argues against.
# GH_TOKEN / GITHUB_TOKEN raises the GitHub rate limit (and reads private repos)
```

## Maintaining the manifest

- A producer published a new version → the scheduled job opens the bump PR;
  `npm run bump` does the same by hand.
- A consumer was upgraded → the check turns red demanding the matching
  `knownDrift` entry be removed. Remove it.
- A new shared component or consumer appears → add it here.
- A consumer moved into the postguard-js monorepo → point `repo`/`manifest` at
  its path in the monorepo and add `"expect": "workspace"`. The next one is
  `postguard-outlook-addon` (encryption4all/postguard-js#127), at which point its
  `knownDrift` entry goes away with the same edit.
