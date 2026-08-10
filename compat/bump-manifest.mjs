// Move compat/manifest.json's `sdk[*].current` up to the published latest.
//
// check-versions.mjs fails when `current` no longer matches what npm/NuGet
// serves. That failure is correct, but nobody outside this repo can act on it:
// a new SDK release makes the nightly red until someone hand-edits the
// manifest. So a scheduled job runs this script and opens a PR with the bump,
// and a red nightly goes back to meaning "a consumer repo drifted".
//
//   node compat/bump-manifest.mjs            # rewrite manifest.json in place
//   node compat/bump-manifest.mjs --dry-run  # report only, touch nothing
//
// The manifest is not the only place a `current` is read: the pins in
// COUPLED_PINS below follow it, and move in the same run — see there for why a
// bump that leaves them behind opens a PR that cannot go green.
//
// Bump lines go to stdout (one `pkg: from -> to` per bump, for the PR body);
// status and warnings go to stderr. No bumps means no stdout and no rewrite,
// so the caller can just check `git diff`.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { latestFor, packageName } from './registries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * What this script would do with one entry, given the registry's answer.
 *
 * Deliberately conservative — the manifest is the known-good set, so an entry is
 * only ever ratcheted forward to a stable release, and is skipped (with a
 * reason) rather than bumped when either side of the comparison is unusable.
 * Pass the reason a lookup failed in `error` and it is reported as such.
 *
 * check-versions.mjs asks the same question before it tells a reader to run
 * `npm run bump`, so the two scripts cannot disagree about which mismatches an
 * automatic bump can clear. Returns `{ action: 'bump' }`,
 * `{ action: 'skip', code, reason }`, or `{ action: 'none' }`.
 */
export function classifyEntry(latest, current, error) {
  if (error) return { action: 'skip', code: 'lookup-failed', reason: error };
  if (!latest) {
    return { action: 'skip', code: 'no-version', reason: 'registry returned no version' };
  }
  if (!semver.valid(latest)) {
    return {
      action: 'skip',
      code: 'latest-not-semver',
      reason: `latest ${latest} is not a semver version`,
    };
  }
  if (semver.prerelease(latest)) {
    // The manifest tracks what consumers are expected to run, and a prerelease
    // is not that.
    return { action: 'skip', code: 'latest-prerelease', reason: `latest ${latest} is a prerelease` };
  }
  if (!semver.valid(current)) {
    // NuGet's native 4-part form (`0.5.0.1`) is the likely way this gets into
    // the manifest by hand. Comparing against it would throw, and this job runs
    // unattended, so report it and leave the entry alone.
    return {
      action: 'skip',
      code: 'current-not-semver',
      reason: `current ${current} is not a semver version`,
    };
  }
  if (semver.gt(latest, current)) return { action: 'bump' };
  // latest <= current: nothing to do. An unpublished or yanked release makes
  // current the higher of the two; check-versions.mjs reports that as drift,
  // which needs a human, not an automatic downgrade.
  return { action: 'none' };
}

/** Decide which `sdk` entries to move, given the latest version per sdk key. */
export function planBumps(manifest, latestByKey, errorByKey = {}) {
  const bumps = [];
  const skipped = [];
  for (const [key, spec] of Object.entries(manifest.sdk)) {
    const pkg = packageName(spec);
    const latest = latestByKey[key];
    const verdict = classifyEntry(latest, spec.current, errorByKey[key]);
    if (verdict.action === 'skip') skipped.push({ key, pkg, reason: verdict.reason });
    else if (verdict.action === 'bump') bumps.push({ key, pkg, from: spec.current, to: latest });
  }
  return { bumps, skipped };
}

/** Status line for a run that produced no bump, honest about which case it was. */
export function noBumpSummary(skippedCount, entryCount) {
  if (entryCount > 0 && skippedCount === entryCount) {
    return 'compat/manifest.json: nothing could be checked, every entry was skipped.';
  }
  const caveat = skippedCount ? ' for every entry that could be checked' : '';
  return `compat/manifest.json already matches the published latest${caveat}.`;
}

/**
 * Span of the object literal enclosing `index`, as [start, end).
 *
 * Walks the text once, string-aware, keeping a stack of open braces. The first
 * `}` popped whose `{` sits before `index` and whose own position sits after it
 * closes the innermost object containing `index`.
 */
function objectSpanAt(text, index, label) {
  const stack = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push(i);
    else if (ch === '}') {
      const start = stack.pop();
      if (start === undefined) break;
      if (start <= index && i > index) return [start, i + 1];
    }
  }
  throw new Error(`${label}: unbalanced braces`);
}

/**
 * Span of the object that is the value of `key`, searched within [from, to).
 *
 * `label` names the file in the error messages: the same surgery runs over
 * manifest.json and over a fixtures package.json, and "no "dependencies" key"
 * is only useful when it says which file was missing it.
 */
function objectValueSpan(text, key, from = 0, to = text.length, label = 'manifest.json') {
  const needle = `"${key}"`;
  const window = text.slice(from, to);
  const at = window.indexOf(needle);
  if (at === -1) throw new Error(`${label}: no "${key}" key`);
  if (window.indexOf(needle, at + 1) !== -1) {
    throw new Error(`${label}: "${key}" is ambiguous — appears more than once`);
  }
  const brace = text.indexOf('{', from + at);
  if (brace === -1) throw new Error(`${label}: "${key}" is not an object`);
  return objectSpanAt(text, brace, label);
}

/**
 * Rewrite one `sdk[key].current` in the manifest SOURCE TEXT.
 *
 * Text surgery rather than JSON.parse + JSON.stringify on purpose: the sdk
 * entries are written one per line, and a stringify round-trip would explode
 * each of them into four lines. The auto-PR's whole value is a diff a
 * maintainer can read at a glance, so every byte we don't touch stays put.
 */
export function setSdkCurrent(text, key, from, to) {
  const [sdkStart, sdkEnd] = objectValueSpan(text, 'sdk');
  const [start, end] = objectValueSpan(text, key, sdkStart, sdkEnd);
  const entry = text.slice(start, end);
  const m = entry.match(/"current"\s*:\s*"([^"]*)"/);
  if (!m) throw new Error(`manifest.json: sdk.${key} has no "current" field`);
  if (m[1] !== from) {
    throw new Error(`manifest.json: sdk.${key} current is "${m[1]}", expected "${from}"`);
  }
  const rewritten = m[0].replace(`"${from}"`, `"${to}"`);
  const patched = entry.slice(0, m.index) + rewritten + entry.slice(m.index + m[0].length);
  return text.slice(0, start) + patched + text.slice(end);
}

/** Apply every planned bump to the manifest source text. */
export function applyBumps(text, bumps) {
  return bumps.reduce((acc, b) => setSdkCurrent(acc, b.key, b.from, b.to), text);
}

/**
 * Dependency pins elsewhere in the tree that must move with an `sdk` entry.
 *
 * `fixtures/readers.mjs` verifies the archival corpus with the `@e4a/pg-js`
 * that `sdk["pg-js"].current` names, and refuses to run when the installed
 * version disagrees. That strictness is the point — a corpus verified by a
 * stale reader is a silent green — so the bumper is the half that has to move:
 * a run that touches only the manifest opens a PR the corpus job fails, for a
 * reason nobody but this script can fix (issue #36).
 *
 * `fixtures`' `@e4a/pg-wasm` is deliberately NOT here. It is pinned published
 * as the client half of the read-forever contract and is meant to age against
 * the corpus; following the manifest would defeat what that pin is for.
 */
export const COUPLED_PINS = {
  'pg-js': { dir: 'fixtures', dep: '@e4a/pg-js' },
};

/** Which coupled pins a set of manifest bumps has to carry along. */
export function planPinUpdates(bumps, coupled = COUPLED_PINS) {
  return bumps.flatMap((b) =>
    coupled[b.key] ? [{ ...coupled[b.key], key: b.key, to: b.to }] : []
  );
}

/**
 * Rewrite one `dependencies` pin in a package.json SOURCE TEXT.
 *
 * Text surgery for the same reason the manifest gets it: the diff a maintainer
 * reads should be the version and nothing else.
 *
 * Unlike `setSdkCurrent` there is no expected `from` to assert against. The
 * state this exists to clear IS the pin disagreeing with the manifest, so the
 * pin's current value is whatever it is and gets reported, not checked. The dep
 * must exist though — a renamed package is a coupling that no longer describes
 * the tree, and guessing at it would leave the corpus verified by a reader
 * nobody chose.
 */
export function setDependencyPin(text, dep, to, label = 'package.json') {
  const [start, end] = objectValueSpan(text, 'dependencies', 0, text.length, label);
  const entry = text.slice(start, end);
  const quoted = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = entry.match(new RegExp(`("${quoted}"\\s*:\\s*)"([^"]*)"`));
  if (!m) throw new Error(`${label}: "dependencies" has no "${dep}"`);
  const from = m[2];
  if (from === to) return { text, from };
  const patched = entry.slice(0, m.index) + `${m[1]}"${to}"` + entry.slice(m.index + m[0].length);
  return { text: text.slice(0, start) + patched + text.slice(end), from };
}

/** The version a package-lock.json records for a top-level dependency. */
export function lockedVersion(lockText, dep) {
  const lock = JSON.parse(lockText);
  return lock.packages?.[`node_modules/${dep}`]?.version ?? null;
}

/**
 * Bring a lockfile back in line with the package.json next to it.
 *
 * Shells out to npm rather than patching the lockfile as text: the entry
 * carries an integrity hash and a resolved URL only the registry can supply,
 * and a new release can change the dependency graph underneath it. The corpus
 * job installs with `npm ci`, which refuses a lockfile that disagrees with
 * package.json — so a hand-patched entry would trade a red gate for a tree
 * that installs the wrong thing. `--package-lock-only` writes no node_modules,
 * and `--ignore-scripts` keeps this unattended job from running package code.
 *
 * A failure here is fatal on purpose: the pin is already written, so carrying
 * on would commit a package.json and lockfile that disagree.
 */
function reconcileLockfile(dir, label) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', '--package-lock-only', '--ignore-scripts'];
  const run = spawnSync(npm, args, { cwd: dir, encoding: 'utf8' });
  if (run.error) {
    throw new Error(
      `${label}: cannot run \`${npm} ${args.join(' ')}\` to reconcile package-lock.json ` +
        `(${run.error.message})`
    );
  }
  if (run.status !== 0) {
    const output = [run.stdout, run.stderr].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
    throw new Error(
      `${label}: \`${npm} ${args.join(' ')}\` exited ${run.status}, so package-lock.json still ` +
        `records the old version${output ? `:\n${output}` : ''}`
    );
  }
}

/**
 * Move every coupled pin (and its lockfile entry) onto the bumped version.
 *
 * Decides per pin by comparing the tree against the target rather than by
 * assuming the pre-bump state. Together with running before the manifest is
 * written (see main), that makes a run interrupted partway converge when it is
 * run again: the pin may already be there while its lockfile is not, and only
 * the tree can say which. Returns one entry per pin that needed work.
 */
export function applyPinUpdates(updates, { dryRun = false, root = repoRoot } = {}) {
  const moved = [];
  for (const update of updates) {
    const dir = join(root, update.dir);
    const manifestFile = join(dir, 'package.json');
    const label = `${update.dir}/package.json`;
    const text = readFileSync(manifestFile, 'utf8');
    const { text: patched, from } = setDependencyPin(text, update.dep, update.to, label);
    const pinWasStale = patched !== text;
    const lockFile = join(dir, 'package-lock.json');
    const lockWasStale = lockedVersion(readFileSync(lockFile, 'utf8'), update.dep) !== update.to;
    if (!pinWasStale && !lockWasStale) continue;

    moved.push({ ...update, from, pinWasStale });
    if (dryRun) continue;
    if (pinWasStale) writeFileSync(manifestFile, patched);
    reconcileLockfile(dir, update.dir);
  }
  return moved;
}

/** The stdout line for one coupled pin this run moved. */
export function pinLine(pin) {
  const what = pin.pinWasStale
    ? `${pin.from} -> ${pin.to}, with its lockfile entry`
    : `lockfile entry reconciled to ${pin.to} (the pin already matched)`;
  return `${pin.dir}: ${pin.dep} ${what}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const file = join(here, 'manifest.json');
  const text = readFileSync(file, 'utf8');
  const manifest = JSON.parse(text);

  const entries = Object.entries(manifest.sdk);
  const latestByKey = {};
  const errorByKey = {};
  for (const [key, spec] of entries) {
    // One unreachable registry must not stop the other packages from bumping,
    // so a failed lookup is reported as a skip like any other unusable answer.
    try {
      latestByKey[key] = await latestFor(spec);
    } catch (e) {
      errorByKey[key] = `registry lookup failed: ${e.message}`;
    }
  }

  const { bumps, skipped } = planBumps(manifest, latestByKey, errorByKey);
  for (const s of skipped) console.error(`  ! ${s.pkg}: ${s.reason}`);

  if (!bumps.length) {
    console.error(noBumpSummary(skipped.length, entries.length));
    return;
  }

  // Coupled pins first, manifest last: a pin (or lockfile) that cannot be
  // written then leaves `current` where it was, so the next run plans the same
  // bump and retries it. The other order strands the tree — `current` is
  // already at latest, so the run after it plans no bumps and never comes back
  // to the pin this one left behind.
  const pins = applyPinUpdates(planPinUpdates(bumps), { dryRun });
  if (!dryRun) writeFileSync(file, applyBumps(text, bumps));

  for (const b of bumps) console.log(`${b.pkg}: ${b.from} -> ${b.to}`);
  for (const pin of pins) console.log(pinLine(pin));
  console.error(
    `\n${bumps.length} bump(s)${dryRun ? ' (dry run, nothing written)' : ' written'}` +
      `${pins.length ? `, plus ${pins.length} coupled pin(s)` : ''}. ` +
      'Consumer ranges are unchanged — run `npm run check` to see who no longer resolves.'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
