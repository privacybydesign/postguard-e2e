// Tests for the reader-row watcher (issue #50).
//
// Nothing here touches the network: the document is a literal string (so
// ghFile is never called) and the registry lookups are injected.
//
// The load-bearing one is "highest in line, not highest overall" — an
// implementation that compares a row against the registry's `latest` passes
// every other test in this file and reports a supported older line as stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRows, parseReaderRows } from './check-reader-rows.mjs';
import { highestInLine, lineOf } from './registries.mjs';

/** A COMPATIBILITY.md with `rows` in the reader block, plus a decoy fence. */
function doc(rows) {
  return [
    '## Reader list',
    '',
    'Prose about the list.',
    '',
    '```',
    '# <registry> <package> <versions...>',
    ...rows,
    '```',
    '',
    'More prose.',
    '',
    '```yaml',
    'name: not-the-reader-block',
    '```',
    '',
  ].join('\n');
}

const published = {
  'crates.io': async () => [
    '0.6.5',
    '0.6.4',
    '0.5.10',
    '0.5.9',
    '0.3.1',
    '0.3.0',
    '0.3.0-rc.2',
    '0.6.4.1',
  ],
  npm: async () => ['2.4.0', '2.3.3', '1.11.0', '1.10.3', '0.6.5'],
};

test('parseReaderRows: reads the rows out of the fenced block', () => {
  const rows = parseReaderRows(doc(['crates.io pg-core 0.6.5 0.5.10', 'npm @e4a/pg-js 2.4.0']));
  assert.deepEqual(rows, [
    { registry: 'crates.io', pkg: 'pg-core', versions: ['0.6.5', '0.5.10'] },
    { registry: 'npm', pkg: '@e4a/pg-js', versions: ['2.4.0'] },
  ]);
});

test('a document whose rows are all current has no problems', async () => {
  const rows = parseReaderRows(
    doc(['crates.io pg-core 0.6.5 0.5.10', '', '# a comment row', 'npm @e4a/pg-js 2.4.0 1.11.0'])
  );
  const { checked, problems } = await checkRows(rows, published);
  assert.deepEqual(problems, []);
  // main() exits 0 exactly when problems is empty, and prints what it checked.
  assert.equal(checked.length, 4);
  assert.match(checked[0], /pg-core 0\.6\.5/);
});

test('a stale row names the package, the pinned version and the published one', async () => {
  const rows = parseReaderRows(doc(['npm @e4a/pg-js 2.3.3 1.11.0']));
  const { problems } = await checkRows(rows, published);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@e4a\/pg-js/);
  assert.match(problems[0], /2\.3\.3/);
  assert.match(problems[0], /2\.4\.0/);
});

test('a row whose registry has no backend is a problem, not a skip', async () => {
  const rows = parseReaderRows(doc(['nuget E4A.PostGuard 0.6.0']));
  const { checked, problems } = await checkRows(rows, published);
  assert.deepEqual(checked, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /E4A\.PostGuard/);
  assert.match(problems[0], /no registry backend/);
});

test('a failing lookup is a problem too, rather than a row silently dropped', async () => {
  const rows = parseReaderRows(doc(['crates.io pg-core 0.6.5']));
  const backends = {
    'crates.io': async () => {
      throw new Error('crates.io pg-core: 403 — We require that all requests include a `User-Agent` header.');
    },
  };
  const { problems } = await checkRows(rows, backends);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lookup failed/);
  assert.match(problems[0], /User-Agent/);
});

test('a document with no reader block throws', () => {
  const md = '## Reader list\n\nNow written as prose: pg-core 0.6.5 and 0.5.10.\n';
  assert.throws(() => parseReaderRows(md), /no fenced block/);
});

test('a reader block that parses to zero rows throws rather than passing vacuously', () => {
  assert.throws(() => parseReaderRows(doc(['', '# only comments here', ''])), /zero rows/);
});

test('highest in line, not highest overall: a 0.5 pin is current while 0.6.5 exists', async () => {
  const rows = parseReaderRows(doc(['crates.io pg-core 0.5.10']));
  const { checked, problems } = await checkRows(rows, published);
  assert.deepEqual(problems, []);
  assert.equal(checked.length, 1);
});

test('a stale row inside an older line is still caught', async () => {
  const rows = parseReaderRows(doc(['crates.io pg-core 0.5.9', 'npm @e4a/pg-js 1.10.3']));
  const { problems } = await checkRows(rows, published);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /pins 0\.5\.9.*is 0\.5\.10/);
  assert.match(problems[1], /pins 1\.10\.3.*is 1\.11\.0/);
});

test('a row pinning nothing is a problem, since it asserts nothing', async () => {
  const rows = parseReaderRows(doc(['crates.io pg-core']));
  const { problems } = await checkRows(rows, published);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pins no versions/);
});

test('a pin with no published release in its line is a problem', async () => {
  const rows = parseReaderRows(doc(['crates.io pg-core 0.4.0']));
  const { problems } = await checkRows(rows, published);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no published release in its line/);
});

// --- The line rule the rows are measured against ---

test('lineOf: minor for a 0.x version, major from 1.0 on', () => {
  assert.equal(lineOf('0.6.5'), '0.6');
  assert.equal(lineOf('0.5.10'), '0.5');
  assert.equal(lineOf('1.11.0'), '1');
  assert.equal(lineOf('2.3.3'), '2');
  // Neither NuGet's 4-part form nor a bare `0.6` names a release.
  assert.equal(lineOf('0.6.4.1'), null);
  assert.equal(lineOf('0.6'), null);
});

test('highestInLine: prereleases and non-plain versions are dropped, not guessed at', () => {
  const versions = ['0.3.0', '0.3.1-rc.1', '0.3.1.1', '0.4.0'];
  assert.equal(highestInLine(versions, '0.3.0'), '0.3.0');
  assert.equal(highestInLine(versions, '0.4.0'), '0.4.0');
  assert.equal(highestInLine(versions, '0.2.0'), null);
  assert.equal(highestInLine(versions, 'not-a-version'), null);
});
