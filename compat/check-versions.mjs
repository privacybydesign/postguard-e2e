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
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const problems = [];
const notes = [];

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
    const aligned = dep && dep.crate === canonical && dep.version === current;
    if (aligned && c.knownDrift) {
      problems.push(
        `${c.name}: now uses ${canonical} ${current} — drift is FIXED. ` +
          `Remove the knownDrift entry from manifest.json.`
      );
    } else if (aligned) {
      notes.push(`${c.name}: uses ${canonical} ${current} ✓`);
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

// Parse the `irma`/`irmars` dependency line from a Cargo.toml. Handles both
// `irma = "0.2.1"` and `irma = { package = "irmars", version = "0.2.2" }` and
// the direct `irmars = "0.2.2"` form. Returns { crate, version } or null.
function parseIrmaDep(toml) {
  for (const raw of toml.split('\n')) {
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
  return null;
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
