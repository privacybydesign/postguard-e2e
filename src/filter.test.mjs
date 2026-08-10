// Unit tests for filterVersions() in filter.mjs. filterVersions is pure and
// resolves a PG_JS_VERSIONS spec against the published version list, so these
// cover every documented spec form: "all", "latest:N", a comma list, a semver
// range, an exact stable version, and an exact prerelease (which used to be
// dropped — see issue #17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterVersions } from './filter.mjs';

// A representative published list: out of order, with a prerelease and one
// invalid entry to prove filtering along the way.
const ALL = ['2.0.0', '1.8.0', '1.9.0', '2.0.0-rc.1', 'not-a-version'];

test('undefined / empty / "all" -> every stable version, ascending', () => {
  const expected = ['1.8.0', '1.9.0', '2.0.0'];
  assert.deepEqual(filterVersions(ALL, 'all'), expected);
  assert.deepEqual(filterVersions(ALL, ''), expected);
  assert.deepEqual(filterVersions(ALL, undefined), expected);
});

test('"all" excludes prereleases and invalid strings', () => {
  assert.ok(!filterVersions(ALL, 'all').includes('2.0.0-rc.1'));
  assert.ok(!filterVersions(ALL, 'all').includes('not-a-version'));
});

test('"latest:N" -> the N highest stable versions, descending', () => {
  assert.deepEqual(filterVersions(ALL, 'latest:2'), ['2.0.0', '1.9.0']);
  assert.deepEqual(filterVersions(ALL, 'latest:1'), ['2.0.0']);
});

test('"latest:" with a missing/garbage count defaults to 1', () => {
  assert.deepEqual(filterVersions(ALL, 'latest:'), ['2.0.0']);
  assert.deepEqual(filterVersions(ALL, 'latest:x'), ['2.0.0']);
});

test('"majors:N" -> the newest stable release of each of the N highest majors', () => {
  assert.deepEqual(filterVersions(ALL, 'majors:2'), ['2.0.0', '1.9.0']);
  assert.deepEqual(filterVersions(ALL, 'majors:1'), ['2.0.0']);
  // More majors than exist is not an error; it is the whole list.
  assert.deepEqual(filterVersions(ALL, 'majors:9'), ['2.0.0', '1.9.0']);
});

test('"majors:" with a missing/garbage count defaults to 1', () => {
  assert.deepEqual(filterVersions(ALL, 'majors:'), ['2.0.0']);
  assert.deepEqual(filterVersions(ALL, 'majors:x'), ['2.0.0']);
});

test('"majors:N" never takes a prerelease, even as its major\'s newest', () => {
  // 3.0.0-rc.1 is the highest 3.x, but an unreleased major is not a support
  // window: asking for two majors here means 2.x and 1.x.
  const all = [...ALL, '3.0.0-rc.1'];
  assert.deepEqual(filterVersions(all, 'majors:2'), ['2.0.0', '1.9.0']);
});

test('comma list -> exactly the listed versions that exist, order preserved', () => {
  assert.deepEqual(filterVersions(ALL, '1.9.0,1.8.0'), ['1.9.0', '1.8.0']);
  // Whitespace is trimmed and unpublished entries are dropped.
  assert.deepEqual(filterVersions(ALL, '1.8.0, 9.9.9'), ['1.8.0']);
});

test('comma list can explicitly name a prerelease', () => {
  assert.deepEqual(filterVersions(ALL, '2.0.0-rc.1,1.8.0'), ['2.0.0-rc.1', '1.8.0']);
});

test('semver range -> every published stable version satisfying it, ascending', () => {
  assert.deepEqual(filterVersions(ALL, '^1.0.0'), ['1.8.0', '1.9.0']);
  assert.deepEqual(filterVersions(ALL, '>=1.9.0'), ['1.9.0', '2.0.0']);
});

test('a range never pulls in a prerelease', () => {
  assert.ok(!filterVersions(ALL, '>=1.0.0').includes('2.0.0-rc.1'));
});

test('exact stable version -> that single version if published', () => {
  assert.deepEqual(filterVersions(ALL, '1.8.0'), ['1.8.0']);
});

test('exact prerelease version -> that single version if published (issue #17)', () => {
  // The regression: this used to hit the range branch, which filters out
  // prereleases, and resolved to [].
  assert.deepEqual(filterVersions(ALL, '2.0.0-rc.1'), ['2.0.0-rc.1']);
});

test('an exact version that is not published -> empty', () => {
  assert.deepEqual(filterVersions(ALL, '9.9.9'), []);
});

test('a spec that is neither a published version nor a valid range -> empty', () => {
  assert.deepEqual(filterVersions(ALL, 'not-a-version'), []);
});
