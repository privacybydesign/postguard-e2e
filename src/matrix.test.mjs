// The support matrix is the declaration of what PostGuard keeps working, so
// these tests pin the two things a reader of a red run needs to trust: that the
// matrix still means "the last two pg-js majors, the last .NET major", and that
// a mistyped profile or leg fails instead of quietly sweeping something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from './config.mjs';
import { filterVersions } from './filter.mjs';
import {
  CLIENTS,
  LEGS,
  PROFILES,
  SUPPORT_MATRIX,
  clientsFor,
  coverageScope,
  missingRequiredLegs,
  resolveClient,
  resolveLegs,
  resolveProfile,
} from './matrix.mjs';

// A published list shaped like @e4a/pg-js's: three major lines, several patches
// on the newest, a prerelease and an invalid entry.
const PG_JS = [
  '0.10.0',
  '1.10.3',
  '1.11.0',
  '2.0.0',
  '2.3.3',
  '2.3.4',
  '2.4.0-rc.1',
  'not-a-version',
];

test('the js matrix resolves to the newest release of each of the last two majors', () => {
  assert.deepEqual(filterVersions(PG_JS, SUPPORT_MATRIX.js), ['2.3.4', '1.11.0']);
});

test('the matrix picks one version per major line, not the last N releases', () => {
  // The difference that matters: latest:2 would sweep two 2.x patches and drop
  // the whole previous major, which is the window consumers actually sit on.
  assert.deepEqual(filterVersions(PG_JS, 'latest:2'), ['2.3.4', '2.3.3']);
});

test('the matrix never sweeps a prerelease it was not asked for', () => {
  assert.ok(!filterVersions(PG_JS, SUPPORT_MATRIX.js).includes('2.4.0-rc.1'));
});

test('a 0.x package has one major line, so the .NET matrix is its newest release', () => {
  // E4A.PostGuard is still 0.x: every release shares major 0, so "the last
  // major" is that line's newest release and asking for two majors cannot
  // invent a second one.
  const nuget = ['0.1.0', '0.4.1', '0.5.0', '0.6.0'];
  assert.deepEqual(filterVersions(nuget, SUPPORT_MATRIX.dotnet), ['0.6.0']);
  assert.deepEqual(filterVersions(nuget, 'majors:2'), ['0.6.0']);
});

test('every profile names a target, both URLs and both legs', () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    assert.ok(profile.target, `${name} has no target`);
    assert.match(profile.pkgUrl, /^https?:\/\//, `${name} pkgUrl`);
    assert.match(profile.cryptifyUrl, /^https?:\/\//, `${name} cryptifyUrl`);
    assert.deepEqual(profile.requires, LEGS, `${name} must hold every leg mandatory`);
  }
});

test('an unknown profile throws instead of falling back to a default', () => {
  assert.throws(() => resolveProfile('nighty'), /unknown profile "nighty"/);
});

test('resolveLegs defaults to every leg and rejects a typo', () => {
  assert.deepEqual(resolveLegs(undefined), LEGS);
  assert.deepEqual(resolveLegs('decrypt'), ['decrypt']);
  assert.deepEqual(resolveLegs('wire, decrypt'), ['wire', 'decrypt']);
  assert.throws(() => resolveLegs('wire,decyrpt'), /unknown leg\(s\) decyrpt/);
  assert.throws(() => resolveLegs(','), /names no leg/);
});

test('resolveClient defaults to every client and rejects a typo', () => {
  // `sweep -- jsx` used to match neither client, sweep nothing and exit 0.
  assert.equal(resolveClient(undefined), 'all');
  assert.equal(resolveClient('DotNet'), 'dotnet');
  assert.throws(() => resolveClient('jsx'), /unknown client "jsx"/);
  assert.deepEqual(clientsFor('all'), CLIENTS);
  assert.deepEqual(clientsFor('js'), ['js']);
});

test('a profile claims the whole matrix, so the positional cannot narrow what it covers', () => {
  // The coverage question under a profile is the matrix's, not the command
  // line's: `sweep --profile nightly js` swept one client and still owes an
  // answer about the other, which is what keeps both gates red on it. Drawing
  // this set from the positional instead let half the declared support matrix
  // pass as covered.
  assert.deepEqual(coverageScope('js', 'nightly'), CLIENTS);
  assert.deepEqual(coverageScope('dotnet', 'pre-deploy'), CLIENTS);
  assert.deepEqual(coverageScope('all', 'nightly'), CLIENTS);
  // Without a profile a narrowing positional means what it says, so working on
  // one adapter is not a fight with a red gate about the other.
  assert.deepEqual(coverageScope('js', null), ['js']);
  assert.deepEqual(coverageScope('all', null), CLIENTS);
});

test('a profile cannot be swept with fewer legs than it holds mandatory', () => {
  const { requires } = resolveProfile('nightly');
  assert.deepEqual(missingRequiredLegs(requires, resolveLegs('wire')), ['decrypt']);
  assert.deepEqual(missingRequiredLegs(requires, resolveLegs(undefined)), []);
  // A manual sweep declares nothing, so it may run one leg.
  assert.deepEqual(missingRequiredLegs(loadConfig({ env: {} }).requires, ['wire']), []);
});

test('a profile supplies the matrix and the target, and records where they came from', () => {
  const config = loadConfig({ profile: 'pre-deploy', env: {} });
  assert.equal(config.target, 'candidate');
  assert.equal(config.pkgUrl, PROFILES['pre-deploy'].pkgUrl);
  assert.equal(config.jsVersions, SUPPORT_MATRIX.js);
  assert.equal(config.jsVersionsSource, 'support matrix');
  assert.equal(config.emailAttribute, 'irma-demo.sidn-pbdf.email.email');
});

test('the environment overrides a profile, and the report says so', () => {
  const config = loadConfig({
    profile: 'nightly',
    env: { PG_PKG_URL: 'http://localhost:9999', PG_JS_VERSIONS: '1.11.0' },
  });
  assert.equal(config.pkgUrl, 'http://localhost:9999');
  assert.equal(config.pkgUrlSource, 'PG_PKG_URL');
  assert.equal(config.jsVersions, '1.11.0');
  assert.equal(config.jsVersionsSource, 'PG_JS_VERSIONS');
});

test('without a profile the manual defaults still apply', () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.profile, null);
  assert.equal(config.jsVersions, 'latest:5');
  assert.equal(config.jsVersionsSource, 'default');
  assert.equal(config.emailAttribute, '');
});
