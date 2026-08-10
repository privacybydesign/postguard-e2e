// The gate's contract, which is the whole point of promoting the sweep into CI:
// which outcomes are a regression, which are not, and — the case a gate gets
// wrong most easily — that a gate which checked nothing is red rather than
// green.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { legVerdict, notSweptClients } from './verdict.mjs';

const report = (js = [], dotnet = [], notSwept = []) => ({ results: { js, dotnet }, notSwept });
const row = (client, version, legs, extra = {}) => ({
  client,
  version,
  install: 'ok',
  error: null,
  legs,
  ...extra,
});

test('every leg passing is green', () => {
  const verdict = legVerdict(
    report([row('js', '2.3.4', { wire: { outcome: 'pass' }, decrypt: { outcome: 'pass' } })]),
    'decrypt'
  );
  assert.deepEqual(verdict, { leg: 'decrypt', ok: true, checked: 1, failures: [] });
});

test('a failed leg is red and the message names the version and the reason', () => {
  const verdict = legVerdict(
    report([
      row('js', '2.3.4', { decrypt: { outcome: 'pass' } }),
      row('js', '1.11.0', { decrypt: { outcome: 'fail', error: 'plaintext mismatch' } }),
    ]),
    'decrypt'
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checked, 2);
  assert.deepEqual(verdict.failures, ['js 1.11.0: failed — plaintext mismatch']);
});

test('a documented refusal is green — the .NET SDK has no reader to drive', () => {
  const verdict = legVerdict(
    report([], [row('dotnet', '0.6.0', { decrypt: { outcome: 'documented_refusal' } })]),
    'decrypt'
  );
  assert.equal(verdict.ok, true);
});

test('a skipped leg is red: a leg that did not run is coverage loss', () => {
  const noKey = legVerdict(
    report([row('js', '2.3.4', { wire: { outcome: 'skipped_no_api_key' } })]),
    'wire'
  );
  assert.equal(noKey.ok, false);
  assert.match(noKey.failures[0], /no PG_API_KEY/);

  const noInstall = legVerdict(
    report([
      row('js', '1.11.0', { wire: { outcome: 'skipped_install_failed', error: 'E404' } }, {
        install: 'fail',
      }),
    ]),
    'wire'
  );
  assert.equal(noInstall.ok, false);
  assert.match(noInstall.failures[0], /no longer installs/);
});

test('a version with no leg for it is red, not silently uncovered', () => {
  const verdict = legVerdict(
    report([row('js', '0.10.0', { decrypt: { outcome: 'no_leg', error: 'no adapter' } })]),
    'decrypt'
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /has no leg for this version/);
});

test('a gate that matched no row is red', () => {
  // The failure mode this file exists for: the sweep ran only the wire leg, the
  // decrypt gate finds nothing to judge, and "0 failures" reads as a pass.
  const verdict = legVerdict(report([row('js', '2.3.4', { wire: { outcome: 'pass' } })]), 'decrypt');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checked, 0);
  assert.match(verdict.failures[0], /no swept version ran the decrypt leg/);
});

test('an empty report is red for every leg', () => {
  for (const leg of ['wire', 'decrypt']) {
    assert.equal(legVerdict(report(), leg).ok, false);
  }
  assert.equal(legVerdict({}, 'wire').ok, false);
});

test('one client cannot certify a leg for the client that produced no rows', () => {
  // The coverage loss a runner without the .NET SDK causes: the pg-js rows
  // populate the leg, so `relevant` is non-empty and the "gate matched no row"
  // guard never fires, and half the declared support matrix passes unswept.
  const passing = [row('js', '2.3.4', { wire: { outcome: 'pass' }, decrypt: { outcome: 'pass' } })];
  assert.equal(legVerdict(report(passing), 'decrypt').ok, true);

  for (const leg of ['wire', 'decrypt']) {
    const verdict = legVerdict(
      report(passing, [], [{ client: 'dotnet', why: 'no dotnet SDK on the machine' }]),
      leg
    );
    assert.equal(verdict.ok, false, `${leg} must be red`);
    assert.match(verdict.failures[0], /dotnet was not swept at all \(no dotnet SDK/);
  }
});

test('a client is only expected when the sweep had it in scope', () => {
  const results = { js: [row('js', '2.3.4', { wire: { outcome: 'pass' } })], dotnet: [] };
  // `sweep -- js` never promised a .NET row, so nothing is missing.
  assert.deepEqual(notSweptClients(['js'], results), []);
  assert.deepEqual(notSweptClients(['js', 'dotnet'], results, { dotnet: 'no dotnet SDK' }), [
    { client: 'dotnet', why: 'no dotnet SDK' },
  ]);
  // No reason recorded still beats no report: the gate says what, not why.
  assert.deepEqual(notSweptClients(['dotnet'], results), [
    { client: 'dotnet', why: 'no version of it was swept' },
  ]);
});

test('an unknown outcome is red rather than assumed benign', () => {
  const verdict = legVerdict(report([row('js', '2.3.4', { wire: { outcome: 'weird' } })]), 'wire');
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /reported weird/);
});
