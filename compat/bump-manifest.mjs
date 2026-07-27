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
// Bump lines go to stdout (one `pkg: from -> to` per bump, for the PR body);
// status and warnings go to stderr. No bumps means no stdout and no rewrite,
// so the caller can just check `git diff`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { latestFor, packageName } from './registries.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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
function objectSpanAt(text, index) {
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
  throw new Error('manifest.json: unbalanced braces');
}

/** Span of the object that is the value of `key`, searched within [from, to). */
function objectValueSpan(text, key, from = 0, to = text.length) {
  const needle = `"${key}"`;
  const window = text.slice(from, to);
  const at = window.indexOf(needle);
  if (at === -1) throw new Error(`manifest.json: no "${key}" key`);
  if (window.indexOf(needle, at + 1) !== -1) {
    throw new Error(`manifest.json: "${key}" is ambiguous — appears more than once`);
  }
  const brace = text.indexOf('{', from + at);
  if (brace === -1) throw new Error(`manifest.json: "${key}" is not an object`);
  return objectSpanAt(text, brace);
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

  if (!dryRun) writeFileSync(file, applyBumps(text, bumps));
  for (const b of bumps) console.log(`${b.pkg}: ${b.from} -> ${b.to}`);
  console.error(
    `\n${bumps.length} bump(s)${dryRun ? ' (dry run, manifest.json untouched)' : ' written'}. ` +
      'Consumer ranges are unchanged — run `npm run check` to see who no longer resolves.'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
