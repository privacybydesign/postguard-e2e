// Regression tests for the auto-bump helpers.
//
// The three things that must not go wrong when a scheduled job rewrites the
// manifest unattended: it must never move `current` backwards or onto a
// prerelease, it must not reformat the file around the version it edits, and it
// must take the pins that follow `current` with it — a manifest bump on its own
// opens a PR the corpus job fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  planBumps,
  applyBumps,
  setSdkCurrent,
  noBumpSummary,
  COUPLED_PINS,
  planPinUpdates,
  setDependencyPin,
  lockedVersion,
  pinLine,
} from './bump-manifest.mjs';
import { highestStable, registryOf, packageName } from './registries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifestText = readFileSync(join(here, 'manifest.json'), 'utf8');
const readTree = (...parts) => readFileSync(join(here, '..', ...parts), 'utf8');
// Read the live values out of the manifest rather than hardcoding them: this
// script's own PRs change them, and a test that pins them would go red on
// every successful bump.
const real = JSON.parse(manifestText);

const fixture = {
  sdk: {
    'pg-js': { npm: '@e4a/pg-js', current: '2.3.1' },
    'pg-dotnet': { nuget: 'E4A.PostGuard', current: '0.5.0' },
  },
};

test('planBumps: a newer published release is bumped', () => {
  const { bumps, skipped } = planBumps(fixture, { 'pg-js': '2.3.3', 'pg-dotnet': '0.5.0' });
  assert.deepEqual(bumps, [{ key: 'pg-js', pkg: '@e4a/pg-js', from: '2.3.1', to: '2.3.3' }]);
  assert.deepEqual(skipped, []);
});

test('planBumps: an unchanged version produces no bump', () => {
  const { bumps } = planBumps(fixture, { 'pg-js': '2.3.1', 'pg-dotnet': '0.5.0' });
  assert.deepEqual(bumps, []);
});

test('planBumps: never downgrades when the registry reports an older version', () => {
  // An unpublished or yanked release. check-versions.mjs reports it as drift;
  // resolving it is a human call, not an automatic edit.
  const { bumps } = planBumps(fixture, { 'pg-js': '2.2.0', 'pg-dotnet': '0.4.1' });
  assert.deepEqual(bumps, []);
});

test('planBumps: skips prereleases and says why', () => {
  const { bumps, skipped } = planBumps(fixture, { 'pg-js': '3.0.0-rc.1', 'pg-dotnet': '0.5.0' });
  assert.deepEqual(bumps, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /prerelease/);
  assert.equal(skipped[0].pkg, '@e4a/pg-js');
});

test('planBumps: skips a missing or unparseable registry answer', () => {
  const { bumps, skipped } = planBumps(fixture, { 'pg-js': undefined, 'pg-dotnet': '1.0.0.1' });
  assert.deepEqual(bumps, []);
  assert.deepEqual(
    skipped.map((s) => s.pkg),
    ['@e4a/pg-js', 'E4A.PostGuard']
  );
  assert.match(skipped[0].reason, /no version/);
  assert.match(skipped[1].reason, /not a semver version/);
});

test('planBumps: skips an unparseable `current` instead of throwing', () => {
  // NuGet accepts a 4-part version that semver cannot parse, so it can reach
  // `current` by hand. `semver.gt` throws on it, and this runs unattended.
  const manifest = { sdk: { 'pg-dotnet': { nuget: 'E4A.PostGuard', current: '0.5.0.1' } } };
  const { bumps, skipped } = planBumps(manifest, { 'pg-dotnet': '0.6.0' });
  assert.deepEqual(bumps, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /current 0\.5\.0\.1 is not a semver version/);
});

test('planBumps: a failed registry lookup is a skip, and other entries still bump', () => {
  const { bumps, skipped } = planBumps(
    fixture,
    { 'pg-js': '2.3.3' },
    { 'pg-dotnet': 'registry lookup failed: NuGet E4A.PostGuard: 503' }
  );
  assert.deepEqual(bumps, [{ key: 'pg-js', pkg: '@e4a/pg-js', from: '2.3.1', to: '2.3.3' }]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /lookup failed.*503/);
});

test('noBumpSummary: does not claim a match when nothing could be checked', () => {
  assert.match(noBumpSummary(2, 2), /nothing could be checked/);
  assert.match(noBumpSummary(0, 2), /already matches the published latest\./);
  assert.match(noBumpSummary(1, 2), /every entry that could be checked/);
});

test('setSdkCurrent: edits only the version, leaving the rest of the file byte-identical', () => {
  const out = setSdkCurrent(manifestText, 'pg-js', real.sdk['pg-js'].current, '9.9.9');
  const before = manifestText.split('\n');
  const after = out.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((l, i) => [i, l, after[i]]).filter(([, a, b]) => a !== b);
  assert.equal(changed.length, 1, `expected one changed line, got ${changed.length}`);
  assert.match(changed[0][2], /"current": "9\.9\.9"/);
  assert.equal(JSON.parse(out).sdk['pg-js'].current, '9.9.9');
});

test('setSdkCurrent: picks the right entry when several carry a "current"', () => {
  const out = setSdkCurrent(manifestText, 'pg-wasm', real.sdk['pg-wasm'].current, '9.9.9');
  const parsed = JSON.parse(out);
  assert.equal(parsed.sdk['pg-wasm'].current, '9.9.9');
  assert.equal(parsed.sdk['pg-js'].current, real.sdk['pg-js'].current);
  // The Rust section has its own `current` — it must be untouched.
  assert.equal(parsed.rust.irmaLib.current, real.rust.irmaLib.current);
});

test('setSdkCurrent: refuses to edit when the manifest has moved on', () => {
  assert.throws(
    () => setSdkCurrent(manifestText, 'pg-js', '1.0.0', '2.0.0'),
    /current is "[^"]+", expected "1\.0\.0"/
  );
});

test('setSdkCurrent: reports an unknown sdk key instead of guessing', () => {
  assert.throws(() => setSdkCurrent(manifestText, 'pg-nope', '1.0.0', '2.0.0'), /no "pg-nope" key/);
});

test('applyBumps: several bumps compose, and the file stays valid JSON', () => {
  const out = applyBumps(manifestText, [
    { key: 'pg-js', pkg: '@e4a/pg-js', from: real.sdk['pg-js'].current, to: '8.8.8' },
    { key: 'pg-wasm', pkg: '@e4a/pg-wasm', from: real.sdk['pg-wasm'].current, to: '9.9.9' },
  ]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.sdk['pg-js'].current, '8.8.8');
  assert.equal(parsed.sdk['pg-wasm'].current, '9.9.9');
  assert.equal(out.split('\n').length, manifestText.split('\n').length);
});

test('applyBumps: an empty plan returns the text unchanged', () => {
  assert.equal(applyBumps(manifestText, []), manifestText);
});

test('planPinUpdates: a pg-js bump carries the fixtures corpus pin', () => {
  const bumps = [{ key: 'pg-js', pkg: '@e4a/pg-js', from: '2.3.1', to: '2.3.3' }];
  assert.deepEqual(planPinUpdates(bumps), [
    { key: 'pg-js', dir: 'fixtures', dep: '@e4a/pg-js', to: '2.3.3' },
  ]);
});

test('planPinUpdates: an entry with no coupled pin carries nothing', () => {
  // pg-wasm is the one to watch: fixtures pins it too, but on purpose at a
  // published version that ages against the corpus. Following the manifest
  // would defeat what that pin is for.
  const bumps = [
    { key: 'pg-wasm', pkg: '@e4a/pg-wasm', from: '0.6.2', to: '0.6.3' },
    { key: 'pg-dotnet', pkg: 'E4A.PostGuard', from: '0.6.0', to: '0.7.0' },
  ];
  assert.deepEqual(planPinUpdates(bumps), []);
  assert.equal(COUPLED_PINS['pg-wasm'], undefined);
});

test('planPinUpdates: every coupled pin names a real sdk key and a real dep', () => {
  for (const [key, pin] of Object.entries(COUPLED_PINS)) {
    assert.ok(real.sdk[key], `COUPLED_PINS.${key} is not an sdk entry`);
    const declared = JSON.parse(readTree(pin.dir, 'package.json')).dependencies?.[pin.dep];
    assert.ok(declared, `${pin.dir}/package.json does not depend on ${pin.dep}`);
  }
});

test('setDependencyPin: edits only the pin, leaving the rest of the file alone', () => {
  const text = readTree('fixtures', 'package.json');
  const { text: out, from } = setDependencyPin(text, '@e4a/pg-js', '9.9.9');
  assert.equal(from, JSON.parse(text).dependencies['@e4a/pg-js']);
  const before = text.split('\n');
  const after = out.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
  assert.equal(changed.length, 1, `expected one changed line, got ${changed.length}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.dependencies['@e4a/pg-js'], '9.9.9');
  // The other fixtures pin is not this script's business.
  assert.equal(parsed.dependencies['@e4a/pg-wasm'], JSON.parse(text).dependencies['@e4a/pg-wasm']);
});

test('setDependencyPin: a pin already at the target is left byte-identical', () => {
  const text = readTree('fixtures', 'package.json');
  const at = JSON.parse(text).dependencies['@e4a/pg-js'];
  assert.equal(setDependencyPin(text, '@e4a/pg-js', at).text, text);
});

test('setDependencyPin: names the file when the dep is not there', () => {
  const text = readTree('fixtures', 'package.json');
  assert.throws(
    () => setDependencyPin(text, '@e4a/pg-nope', '1.0.0', 'fixtures/package.json'),
    /fixtures\/package\.json: "dependencies" has no "@e4a\/pg-nope"/
  );
});

test('lockedVersion: reads the installed version, not the declared range', () => {
  const lock = readTree('fixtures', 'package-lock.json');
  assert.equal(lockedVersion(lock, '@e4a/pg-js'), real.sdk['pg-js'].current);
  assert.equal(lockedVersion(lock, '@e4a/pg-absent'), null);
});

test('pinLine: says whether the pin moved or only its lockfile', () => {
  const pin = { dir: 'fixtures', dep: '@e4a/pg-js', from: '2.3.3', to: '2.3.4' };
  assert.equal(
    pinLine({ ...pin, pinWasStale: true }),
    'fixtures: @e4a/pg-js 2.3.3 -> 2.3.4, with its lockfile entry'
  );
  assert.match(pinLine({ ...pin, pinWasStale: false }), /lockfile entry reconciled to 2\.3\.4/);
});

test('the fixtures corpus reader is pinned to the manifest current, in both files', () => {
  // The invariant fixtures/readers.mjs enforces at verify time, asserted here
  // where it costs a second instead of a corpus run: a tree where these
  // disagree is the red PR issue #36 is about.
  const declared = JSON.parse(readTree('fixtures', 'package.json')).dependencies['@e4a/pg-js'];
  assert.equal(declared, real.sdk['pg-js'].current);
  assert.equal(lockedVersion(readTree('fixtures', 'package-lock.json'), '@e4a/pg-js'), declared);
});

test('highestStable: maximum stable version, not the last one listed', () => {
  // The NuGet flat-container index is not guaranteed to be semver-sorted, and
  // it includes prereleases.
  assert.equal(highestStable(['0.1.0', '0.10.0', '0.9.0']), '0.10.0');
  assert.equal(highestStable(['0.4.0', '0.5.0', '0.6.0-beta1']), '0.5.0');
  assert.equal(highestStable(['1.0.0.1']), null);
  assert.equal(highestStable([]), null);
});

test('registryOf: dispatches on the declared registry', () => {
  assert.deepEqual(registryOf({ npm: '@e4a/pg-js' }), { kind: 'npm', pkg: '@e4a/pg-js' });
  assert.deepEqual(registryOf({ nuget: 'E4A.PostGuard' }), {
    kind: 'nuget',
    pkg: 'E4A.PostGuard',
  });
  assert.equal(packageName({ nuget: 'E4A.PostGuard' }), 'E4A.PostGuard');
  assert.throws(() => registryOf({ current: '1.0.0' }), /neither "npm" nor "nuget"/);
});

test('every sdk entry in the real manifest declares a registry this can read', () => {
  for (const spec of Object.values(JSON.parse(manifestText).sdk)) {
    assert.ok(registryOf(spec).pkg);
  }
});
