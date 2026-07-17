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

const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

async function npmLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!res.ok) throw new Error(`npm registry ${pkg}: ${res.status}`);
  const json = await res.json();
  return json['dist-tags']?.latest;
}

async function ghFile(repo, path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: {
      Accept: 'application/vnd.github.raw',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${repo}/${path}: ${res.status}`);
  return res.text();
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

async function main() {
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  const problems = [];
  const notes = [];

  // --- 1. SDK producers: manifest.current must match what npm actually serves ---
  const sdkCurrent = {};
  for (const [name, spec] of Object.entries(manifest.sdk)) {
    const latest = await npmLatest(spec.npm);
    sdkCurrent[spec.npm] = spec.current;
    if (latest !== spec.current) {
      problems.push(
        `${spec.npm}: manifest says current=${spec.current} but npm latest=${latest}. ` +
          `Bump manifest.sdk.${name}.current (and re-check consumers).`
      );
    } else {
      notes.push(`${spec.npm} = ${latest} (matches manifest)`);
    }
  }

  // --- 2. SDK consumers: each declared range must resolve the current SDK ---
  for (const c of manifest.sdkConsumers) {
    let range;
    try {
      const pkg = JSON.parse(await ghFile(c.repo, c.manifest));
      range =
        pkg.dependencies?.[c.dep] ??
        pkg.devDependencies?.[c.dep] ??
        pkg.peerDependencies?.[c.dep];
    } catch (e) {
      problems.push(`${c.name}: could not read ${c.manifest} (${e.message})`);
      continue;
    }
    if (!range) {
      problems.push(`${c.name}: does not declare ${c.dep}`);
      continue;
    }
    const current = sdkCurrent[c.dep];
    const ok = semver.satisfies(current, range, { includePrerelease: true });
    if (ok && c.knownDrift) {
      problems.push(
        `${c.name}: ${c.dep} ${range} now resolves ${current} — drift is FIXED. ` +
          `Remove the knownDrift entry from manifest.json.`
      );
    } else if (ok) {
      notes.push(`${c.name}: ${c.dep} ${range} resolves ${current} ✓`);
    } else if (c.knownDrift) {
      notes.push(
        `${c.name}: ${c.dep} ${range} CANNOT resolve ${current} — known drift ` +
          `(${c.knownDrift.issue}): ${c.knownDrift.reason}`
      );
    } else {
      problems.push(
        `${c.name}: ${c.dep} ${range} cannot resolve current ${current}. ` +
          `Bump the pin, or record it as knownDrift with a tracking issue.`
      );
    }
  }

  // --- 3. Rust IRMA library: consumers must use the canonical crate + version ---
  {
    const { canonical, current, consumers } = manifest.rust.irmaLib;
    for (const c of consumers) {
      let toml;
      try {
        toml = await ghFile(c.repo, c.manifest);
      } catch (e) {
        problems.push(`${c.name}: could not read ${c.manifest} (${e.message})`);
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
