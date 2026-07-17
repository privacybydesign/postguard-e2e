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

- **SDK producers** — `manifest.sdk[*].current` must equal what npm serves
  (so the manifest can't go stale).
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
| cryptify | Rust IRMA lib | uses legacy `irma 0.2.1`, not `irmars 0.2.2` | encryption4all/cryptify#194 |

## Run it

```bash
cd compat && npm ci && npm run check
# GH_TOKEN / GITHUB_TOKEN raises the GitHub rate limit (and reads private repos)
```

## Maintaining the manifest

- A producer published a new version → bump `sdk[*].current` (the check verifies
  it against npm).
- A consumer was upgraded → the check turns red demanding the matching
  `knownDrift` entry be removed. Remove it.
- A new shared component or consumer appears → add it here.
