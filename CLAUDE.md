# postguard-e2e

The central end-to-end test harness for PostGuard. Three parts, each with its
own README:

- `stack/` — a self-contained docker-compose stack (PKG + irma-server +
  cryptify + mailcrab), with the irma-server wired for `irma-demo` issuance so
  a test can issue itself a credential and then disclose it.
- `yivi-driver/` — a headless Yivi holder on irmago's `client.Client`, so CI
  can drive a real disclosure with no phone.
- the version sweep (`src/`) — published client releases run against a target
  server. `compat/` beside it detects cross-repo version drift, `fixtures/`
  holds the archival container corpus.

PostGuard is end-to-end encrypted email and file sending over identity-based
encryption: you encrypt to an email address, and the recipient proves that
identity to a Private Key Generator to get a decryption key. Yivi does the
identity authentication, which is why this harness runs an irma-server.

One company, two GitHub orgs: `encryption4all` is PostGuard, `privacybydesign`
is the Yivi/IRMA lineage. The split is historical, not organisational — we are
maintainers on both sides, so a fix that belongs in a sibling repo can be made
there instead of worked around here.

## The position this repo takes

**The integration canary.** This is the one place both products are exercised
together, so a cross-product break surfaces here first. Nothing here ships to a
user: a red run is usually a statement about another repo, and the fix usually
belongs in that repo rather than in the harness.

The support matrix is **data** in `src/matrix.mjs`, deliberately not a workflow
`matrix:` block, so the nightly run, the pre-deploy gate and a hand sweep all
read the same set.

## Repos to weigh before changing this one

- `encryption4all/postguard` — the root of the family: `pg-core`, the PKG
  server, and `cryptify/`. `stack/` builds the PKG from a sibling checkout of
  it, unpinned on purpose. Its `COMPATIBILITY.md` is what the sweep's support
  windows are measured against. Cryptify is the exception: `stack/` builds it
  from its own `../../cryptify` checkout, a snapshot of a repo that is now
  archived, so an edit to `postguard/cryptify` does not reach this stack.
- `encryption4all/postguard-js`, `encryption4all/postguard-dotnet` — the two
  clients the sweep installs from npm and NuGet. A version the support matrix
  declares supported is a promise those repos have to keep.
- `encryption4all/postguard-business` — owns the `business-db` schema. `stack/`
  applies its real migrations; asserting against a schema written here instead
  is the regression postguard#237 was about.
- `privacybydesign/irmago` — `yivi-driver` builds against it through a `go.mod`
  replace on a sibling checkout, pinned by sha in `.github/workflows/e2e.yml`.
- `encryption4all/postguard-docs` — `docs.postguard.eu`. Documentation for this
  repo belongs there, not in this file.

## Where the rest of this file went

It was 18,069 bytes of accumulated agent notes at `b9eafcc`, the last revision
carrying them: `git show b9eafcc:CLAUDE.md`. Nothing was migrated. The
documentation half was already in the READMEs and in source comments beside the
code it described; the durable checks are binding rules now, assembled per task
and landed in the container at `~/dobby-rules.md`. A container that learns
something durable files a rule; it does not write it here.
`src/claude-md-orientation.test.mjs` holds this file to 4,000 bytes.
