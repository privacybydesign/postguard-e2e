// The report is the artifact the two gates read and a human reads after a red
// nightly, so its header must not say something the gates contradict. Writes into
// `report/`, which is gitignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from './config.mjs';
import { writeReport } from './report.mjs';

const config = loadConfig({ profile: 'nightly', env: {} });
const header = (results, run) => writeReport(results, config, run).markdown.split('\n## ')[0];

const empty = { js: [], dotnet: [] };

test('the header says a decrypt leg ran even when nothing sealed an artifact', () => {
  // A dotnet-only sweep seals nothing (only the pg-js leg opens the artifact)
  // while its rows still carry a decrypt outcome — the reflection probe's, which
  // the gate counts as green and as checked. "Not run" beside a green decrypt
  // gate is the contradiction worth avoiding here.
  const md = header(empty, { legs: ['wire', 'decrypt'], decrypt: null });
  assert.match(md, /Decrypt legs: ran with no sealed artifact/);

  // A sweep that was not asked for the leg at all: "not run" is the truth.
  assert.match(header(empty, { legs: ['wire'], decrypt: null }), /Decrypt legs: not run/);

  const sealed = header(empty, {
    legs: ['decrypt'],
    decrypt: { sealerVersion: '0.6.2', universe: 'pg-core-0.6.1', recipientId: 'a@example.com' },
  });
  assert.match(sealed, /sealed by `@e4a\/pg-wasm@0\.6\.2` into the `pg-core-0\.6\.1`/);
});

test('a client that went unswept is named in the report, not only in the gate', () => {
  const md = header(empty, {
    legs: ['wire', 'decrypt'],
    notSwept: [{ client: 'dotnet', why: 'the sweep was asked for js only' }],
  });
  assert.match(md, /\*\*Not swept: dotnet\*\* — the sweep was asked for js only/);
});
