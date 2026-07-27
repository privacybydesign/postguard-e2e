// Regression tests for the Cargo-parsing / version-matching helpers in
// check-versions.mjs. These cover the two robustness gaps raised in review on
// PR #16: the Rust path must treat Cargo pins as ranges (not exact strings),
// and parseIrmaDep must recognise the `[dependencies.irmars]` table form.
//
// Plus the producer check's remedy line: it may only send a reader to
// `npm run bump` for a mismatch bump-manifest.mjs would actually act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { parseIrmaDep, cargoReqToRange, sdkVerdict } from './check-versions.mjs';
import { classifyEntry } from './bump-manifest.mjs';

test('cargoReqToRange: a bare version is caret (Cargo default), not exact', () => {
  assert.equal(cargoReqToRange('0.2.2'), '^0.2.2');
  assert.equal(cargoReqToRange('0.2'), '^0.2');
  assert.equal(cargoReqToRange('1'), '^1');
});

test('cargoReqToRange: explicit operators are preserved', () => {
  assert.equal(cargoReqToRange('^0.2.2'), '^0.2.2');
  assert.equal(cargoReqToRange('~0.2'), '~0.2');
  assert.equal(cargoReqToRange('=0.2.2'), '=0.2.2');
  assert.equal(cargoReqToRange('*'), '*');
});

test('cargoReqToRange: comma-joined comparators become a space-joined range', () => {
  assert.equal(cargoReqToRange('>=0.2, <0.4'), '>=0.2 <0.4');
});

test('Rust version check no longer reports false drift for caret / newer patch', () => {
  // The bug: `dep.version === current` flagged these as drift. With ranges they resolve.
  assert.ok(semver.satisfies('0.2.3', cargoReqToRange('0.2')));
  assert.ok(semver.satisfies('0.2.3', cargoReqToRange('0.2.2')));
  assert.ok(semver.satisfies('0.2.2', cargoReqToRange('0.2.2')));
  // Genuinely incompatible pins are still rejected.
  assert.ok(!semver.satisfies('0.3.0', cargoReqToRange('0.2.2')));
  assert.ok(!semver.satisfies('0.2.1', cargoReqToRange('=0.2.2')));
});

test('parseIrmaDep: inline forms', () => {
  assert.deepEqual(parseIrmaDep('irma = "0.2.1"\n'), { crate: 'irma', version: '0.2.1' });
  assert.deepEqual(parseIrmaDep('irmars = "0.2.2"\n'), { crate: 'irmars', version: '0.2.2' });
  assert.deepEqual(
    parseIrmaDep('irma = { package = "irmars", version = "0.2.2" }\n'),
    { crate: 'irmars', version: '0.2.2' }
  );
});

test('parseIrmaDep: [dependencies.irmars] table-section form', () => {
  const toml = [
    '[package]',
    'name = "demo"',
    '',
    '[dependencies.irmars]',
    'version = "0.2.2"',
    'features = ["foo"]',
    '',
    '[dev-dependencies]',
    'anyhow = "1"',
  ].join('\n');
  assert.deepEqual(parseIrmaDep(toml), { crate: 'irmars', version: '0.2.2' });
});

test('parseIrmaDep: table-section form with a package rename', () => {
  const toml = [
    '[dependencies.irma]',
    'package = "irmars"',
    'version = "0.2.2"',
  ].join('\n');
  assert.deepEqual(parseIrmaDep(toml), { crate: 'irmars', version: '0.2.2' });
});

test('parseIrmaDep: table-section header stops at the next section', () => {
  const toml = [
    '[dependencies.irmars]',
    '',
    '[dependencies.serde]',
    'version = "1.0"',
  ].join('\n');
  assert.deepEqual(parseIrmaDep(toml), { crate: 'irmars', version: null });
});

test('parseIrmaDep: returns null when no irma dependency is present', () => {
  assert.equal(parseIrmaDep('[dependencies]\nserde = "1.0"\n'), null);
});

// --- The producer check must not ask for a bump the bumper will not make ---

const dotnet = { name: 'pg-dotnet', pkg: 'E4A.PostGuard', current: '0.5.0' };

test('sdkVerdict: a matching version is a note', () => {
  const v = sdkVerdict({ ...dotnet, latest: '0.5.0' });
  assert.equal(v.level, 'note');
  assert.match(v.message, /matches manifest/);
});

test('sdkVerdict: a newer stable release is drift, and `npm run bump` clears it', () => {
  const v = sdkVerdict({ ...dotnet, latest: '0.6.0' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /Run `npm run bump`/);
  // The instruction is only honest if the bumper agrees it would move this.
  assert.equal(classifyEntry('0.6.0', dotnet.current).action, 'bump');
});

test('sdkVerdict: a prerelease on the `latest` dist-tag is a note, not a permanent red', () => {
  // planBumps skips prereleases and exits 0, so a red here could never clear:
  // no bump PR is opened and the instruction to run one does nothing.
  const v = sdkVerdict({ name: 'pg-js', pkg: '@e4a/pg-js', current: '2.3.3', latest: '2.4.0-rc.1' });
  assert.equal(v.level, 'note');
  assert.doesNotMatch(v.message, /npm run bump/);
  assert.match(v.message, /2\.4\.0-rc\.1 is a prerelease/);
  assert.equal(classifyEntry('2.4.0-rc.1', '2.3.3').code, 'latest-prerelease');
});

test('sdkVerdict: an unusable registry answer stays red but does not promise a bump', () => {
  for (const latest of [null, '1.0.0.1']) {
    const v = sdkVerdict({ ...dotnet, latest });
    assert.equal(v.level, 'problem');
    assert.doesNotMatch(v.message, /Run `npm run bump`/);
    assert.match(v.message, /leaves this entry alone/);
  }
});

test('sdkVerdict: an unparseable `current` stays red and names itself as the cause', () => {
  const v = sdkVerdict({ ...dotnet, current: '0.5.0.1', latest: '0.6.0' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /current 0\.5\.0\.1 is not a semver version/);
});

test('sdkVerdict: a registry older than the manifest stays red, since bumps only ratchet up', () => {
  const v = sdkVerdict({ ...dotnet, latest: '0.4.1' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /0\.4\.1 is older than current 0\.5\.0/);
  assert.equal(classifyEntry('0.4.1', dotnet.current).action, 'none');
});
