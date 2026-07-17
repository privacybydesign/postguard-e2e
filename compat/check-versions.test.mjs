// Regression tests for the Cargo-parsing / version-matching helpers in
// check-versions.mjs. These cover the two robustness gaps raised in review on
// PR #16: the Rust path must treat Cargo pins as ranges (not exact strings),
// and parseIrmaDep must recognise the `[dependencies.irmars]` table form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { parseIrmaDep, cargoReqToRange } from './check-versions.mjs';

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
