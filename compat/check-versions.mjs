// PostGuard cross-repo version drift detector (EPIC #201, Phase 3).
//
// Reads the LIVE versions each repo declares (npm registry + GitHub) and checks
// them against compat/manifest.json. Fails on drift that is NOT recorded in a
// `knownDrift` block, and also fails if a `knownDrift` entry has since been
// fixed (so the allowlist can't rot). This ratchets: existing drift is tracked
// and no new drift slips in silently.
//
//   node compat/check-versions.mjs
//
// Auth: set GH_TOKEN / GITHUB_TOKEN to raise the GitHub rate limit (and to read
// private repos). Public repos work unauthenticated for the handful of reads.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { latestFor, packageName } from './registries.mjs';
import { classifyEntry } from './bump-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

async function ghFile(repo, path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: {
      Accept: 'application/vnd.github.raw',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${repo}/${path}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * How an unreadable manifest is reported. Always a problem — an entry whose
 * file cannot be read is monitoring nothing, and a `knownDrift` block does not
 * excuse it.
 *
 * A 404 gets its own wording because it is not a transient hiccup: the repo or
 * the path is gone (a move, a rename, a consolidation), and the fix is an edit
 * to manifest.json rather than a retry.
 */
export function readFailureMessage(consumer, error) {
  if (error?.status === 404) {
    return (
      `${consumer.name}: ${consumer.repo}/${consumer.manifest} does not exist (GitHub 404), ` +
      `so this entry monitors nothing. Point repo/manifest at the file the code lives in now.`
    );
  }
  return `${consumer.name}: could not read ${consumer.manifest} (${error.message})`;
}

// A Cargo version requirement is a RANGE, and a bare version defaults to caret
// semantics (`irmars = "0.2"` means `^0.2`, i.e. >=0.2.0 <0.3.0), unlike npm
// where a bare version is exact. Normalise a Cargo requirement into a range
// semver.satisfies understands, so the Rust path matches the npm consumer path:
// a caret pin or a newer compatible patch release is not reported as drift.
export function cargoReqToRange(req) {
  // Cargo joins multiple comparators with commas; semver ranges use spaces.
  let r = String(req).trim().replace(/\s*,\s*/g, ' ');
  // A bare version (starts with a digit) is caret in Cargo, exact in npm.
  if (/^\d/.test(r)) r = `^${r}`;
  return r;
}

// Parse the `irma`/`irmars` dependency from a Cargo.toml. Handles the inline
// forms (`irma = "0.2.1"`, `irmars = "0.2.2"`, and the renamed
// `irma = { package = "irmars", version = "0.2.2" }`) as well as the
// table-section form:
//
//   [dependencies.irmars]
//   version = "0.2.2"
//
// Returns { crate, version } (version may be null if not stated) or null.
export function parseIrmaDep(toml) {
  const lines = toml.split('\n');

  // Inline forms: `irma = ...` / `irmars = ...` on a single line.
  for (const raw of lines) {
    const l = raw.trim();
    const m = l.match(/^(irma|irmars)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const rhs = m[2];
    const pkg = rhs.match(/package\s*=\s*"([^"]+)"/);
    const crate = pkg ? pkg[1] : key;
    const ver = rhs.match(/version\s*=\s*"([^"]+)"/) || rhs.match(/^"([^"]+)"/);
    return { crate, version: ver ? ver[1] : null };
  }

  // Table-section form: `[dependencies.irma]` / `[...irmars]` header followed by
  // `version = "..."` and an optional `package = "..."` until the next section.
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].trim().match(/^\[.*\.(irma|irmars)\]$/);
    if (!header) continue;
    let crate = header[1];
    let version = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (l.startsWith('[')) break;
      const pkg = l.match(/^package\s*=\s*"([^"]+)"/);
      if (pkg) crate = pkg[1];
      const ver = l.match(/^version\s*=\s*"([^"]+)"/);
      if (ver) version = ver[1];
    }
    return { crate, version };
  }

  return null;
}

/**
 * How one `sdk` producer entry is reported: `{ level: 'note' | 'problem', message }`.
 *
 * Only points at `npm run bump` when the bumper would in fact move the entry.
 * It ratchets forward to a stable release only, so a prerelease on the `latest`
 * dist-tag is a note here: telling the reader to bump would leave the nightly
 * red on an instruction that provably does nothing (bump-manifest.mjs skips the
 * entry and exits 0). The other mismatches the bumper refuses stay red, but say
 * so instead of promising a fix.
 */
export function sdkVerdict({ name, pkg, current, latest }) {
  if (latest === current) {
    return { level: 'note', message: `${pkg} = ${latest} (matches manifest)` };
  }
  const verdict = classifyEntry(latest, current);
  if (verdict.action === 'bump') {
    return {
      level: 'problem',
      message:
        `${pkg}: manifest says current=${current} but registry latest=${latest}. ` +
        `Run \`npm run bump\` to move manifest.sdk.${name}.current (and re-check consumers).`,
    };
  }
  if (verdict.code === 'latest-prerelease') {
    return {
      level: 'note',
      message: `${pkg} = ${current} (registry latest=${latest} is a prerelease, which the manifest does not track)`,
    };
  }
  const why = verdict.reason ?? `latest ${latest} is older than current ${current}`;
  return {
    level: 'problem',
    message:
      `${pkg}: manifest says current=${current} but registry latest=${latest}. ` +
      `\`npm run bump\` leaves this entry alone (${why}), so it needs a hand.`,
  };
}

/**
 * How one `sdkConsumers` entry is reported: `{ level: 'note' | 'problem', message }`.
 *
 * `expect` picks which question is asked, because there are two kinds of consumer:
 *
 * - no `expect` — an external repo. Its declared range must resolve the current
 *   published SDK.
 * - `expect: "workspace"` — a member of the postguard-js monorepo. The dep is a
 *   `workspace:` link, which by construction cannot drift, so asking which
 *   version it resolves is meaningless. What is worth asserting is that it is
 *   *still* a workspace link: a member that regresses to a fixed pin
 *   reintroduces exactly the drift the consolidation removed.
 *
 * Both go through the same ratchet as before — drift covered by `knownDrift` is
 * a note, new drift is a problem, and drift that has since been fixed is a
 * problem so the allowlist cannot rot.
 */
export function consumerVerdict({ consumer: c, spec, current }) {
  if (!spec) return { level: 'problem', message: `${c.name}: does not declare ${c.dep}` };

  let ok, resolved, driftShort, drift;
  if (c.expect === 'workspace') {
    ok = spec.startsWith('workspace:');
    resolved = `${c.dep} ${spec} is a workspace link`;
    driftShort = `${c.dep} is "${spec}", NOT a workspace link`;
    drift =
      `${c.dep} is "${spec}", no longer a workspace link. A monorepo member on a ` +
      `fixed pin reintroduces the drift the consolidation removed — restore ` +
      `"${c.dep}": "workspace:*", or record it as knownDrift with a tracking issue.`;
  } else if (c.expect === undefined) {
    ok = semver.satisfies(current, spec, { includePrerelease: true });
    resolved = `${c.dep} ${spec} resolves ${current}`;
    driftShort = `${c.dep} ${spec} CANNOT resolve ${current}`;
    drift =
      `${c.dep} ${spec} cannot resolve current ${current}. ` +
      `Bump the pin, or record it as knownDrift with a tracking issue.`;
  } else {
    return {
      level: 'problem',
      message:
        `${c.name}: unknown "expect" value ${JSON.stringify(c.expect)} in manifest.json ` +
        `(use "workspace", or leave the field out for an external consumer).`,
    };
  }

  if (ok && c.knownDrift) {
    return {
      level: 'problem',
      message:
        `${c.name}: ${resolved} — drift is FIXED. ` +
        `Remove the knownDrift entry from manifest.json.`,
    };
  }
  if (ok) return { level: 'note', message: `${c.name}: ${resolved} ✓` };
  if (c.knownDrift) {
    return {
      level: 'note',
      message: `${c.name}: ${driftShort} — known drift (${c.knownDrift.issue}): ${c.knownDrift.reason}`,
    };
  }
  return { level: 'problem', message: `${c.name}: ${drift}` };
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  const problems = [];
  const notes = [];

  // --- 1. SDK producers: manifest.current must match what the registry serves ---
  const sdkCurrent = {};
  for (const [name, spec] of Object.entries(manifest.sdk)) {
    const pkg = packageName(spec);
    const latest = await latestFor(spec);
    sdkCurrent[pkg] = spec.current;
    const { level, message } = sdkVerdict({ name, pkg, current: spec.current, latest });
    (level === 'problem' ? problems : notes).push(message);
  }

  // --- 2. SDK consumers: an external range must resolve the current SDK; a
  //        monorepo member must still be a workspace link ---
  for (const c of manifest.sdkConsumers) {
    let spec;
    try {
      const pkg = JSON.parse(await ghFile(c.repo, c.manifest));
      spec =
        pkg.dependencies?.[c.dep] ??
        pkg.devDependencies?.[c.dep] ??
        pkg.peerDependencies?.[c.dep];
    } catch (e) {
      problems.push(readFailureMessage(c, e));
      continue;
    }
    const { level, message } = consumerVerdict({
      consumer: c,
      spec,
      current: sdkCurrent[c.dep],
    });
    (level === 'problem' ? problems : notes).push(message);
  }

  // --- 3. Rust IRMA library: consumers must use the canonical crate + version ---
  {
    const { canonical, current, consumers } = manifest.rust.irmaLib;
    for (const c of consumers) {
      let toml;
      try {
        toml = await ghFile(c.repo, c.manifest);
      } catch (e) {
        problems.push(readFailureMessage(c, e));
        continue;
      }
      const dep = parseIrmaDep(toml);
      const aligned =
        dep &&
        dep.crate === canonical &&
        dep.version != null &&
        semver.satisfies(current, cargoReqToRange(dep.version), { includePrerelease: true });
      if (aligned && c.knownDrift) {
        problems.push(
          `${c.name}: now uses ${canonical} ${current} — drift is FIXED. ` +
            `Remove the knownDrift entry from manifest.json.`
        );
      } else if (aligned) {
        notes.push(`${c.name}: uses ${canonical} ${dep.version} (resolves ${current}) ✓`);
      } else if (c.knownDrift) {
        notes.push(
          `${c.name}: uses ${dep ? `${dep.crate} ${dep.version}` : '???'} not ${canonical} ${current} — ` +
            `known drift (${c.knownDrift.issue}): ${c.knownDrift.reason}`
        );
      } else {
        problems.push(
          `${c.name}: uses ${dep ? `${dep.crate} ${dep.version}` : '???'}, expected ${canonical} ${current}.`
        );
      }
    }
  }

  // --- Report ---
  console.log('PostGuard version compatibility check\n');
  for (const n of notes) console.log(`  · ${n}`);
  if (problems.length) {
    console.log('\nDRIFT / PROBLEMS:');
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`\n${problems.length} problem(s). See compat/manifest.json.`);
    process.exit(1);
  }
  console.log('\nAll components consistent with the manifest (known drift tracked).');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
