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
- **SDK consumers** — each repo's declared `@e4a/pg-js` range must resolve the
  current published version (`semver.satisfies`).
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

The bump only ratchets forward. A prerelease, a version the registry serves
that semver can't parse, or a latest older than `current` (an unpublished
release) is reported and skipped, never applied. `check-versions.mjs` asks the
bumper about each of those before it points a reader at `npm run bump`: a
prerelease on the `latest` dist-tag is a note there rather than a red, and the
rest say what actually needs doing instead of naming a bump that won't run.

```bash
cd compat && npm run bump              # rewrite manifest.json in place
cd compat && npm run bump -- --dry-run # report only
```

Bumps go to stdout as `pkg: from -> to`, one per line, for the PR body; status
and skips go to stderr. Nothing to bump means no output and no rewrite.

The Rust `irmaLib.current` is not auto-bumped: crates.io is not wired up, and
that version moves with a deliberate migration rather than a release.

## Run it

```bash
cd compat && npm ci && npm test && npm run check
# GH_TOKEN / GITHUB_TOKEN raises the GitHub rate limit (and reads private repos)
```

## Maintaining the manifest

- A producer published a new version → the scheduled job opens the bump PR;
  `npm run bump` does the same by hand.
- A consumer was upgraded → the check turns red demanding the matching
  `knownDrift` entry be removed. Remove it.
- A new shared component or consumer appears → add it here.
