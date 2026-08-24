//! Proof that the schema gate bites.
//!
//! `meta.json` carries a schema version so that a set sealed in a layout a
//! reader predates is **refused**, not read past. That only holds if the
//! refusal has been observed: a verifier that skips what it does not
//! understand and reports success is the failure this field exists to prevent,
//! and it looks exactly like a green run.
//!
//! The committed corpus is checked with the real `corpus.mjs`. The refusal is
//! checked against a miniature corpus in a temporary directory, with a copy of
//! `corpus.mjs` beside it — the same trick `append-only.test.mjs` uses for the
//! gate scripts, because `FIXTURES` is derived from the module's own location
//! and a fabricated set must not land in the real one.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fixtureSets,
  isCorpusPath,
  loadSet,
  SUPPORTED_SCHEMA_VERSIONS,
  TAMPER_KINDS,
} from './corpus.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url));

describe('the committed corpus', () => {
  it('is read whole: every set declares a schema this verifier knows', () => {
    // fixtureSets() throws on an unsupported schema, so loading them all is
    // the assertion. A set appended without teaching the verifiers fails here
    // rather than in a nightly run nobody is watching.
    const sets = fixtureSets();
    for (const set of sets) {
      assert.ok(
        SUPPORTED_SCHEMA_VERSIONS.includes(set.meta.schemaVersion ?? 1),
        `${set.name}: schemaVersion ${set.meta.schemaVersion}`
      );
    }
  });

  it('carries the pg-core 0.6.4 set, the first sealed in the pub_pol format', () => {
    // postguard#347/#351: 0.6.4 is the first release that writes the
    // AEAD-protected copy of the sender's public signing policy. Without this
    // set the archival guarantee says nothing about the format every new
    // container is sealed in.
    const set = loadSet('pg-core-0.6.4');
    assert.equal(set.meta.schemaVersion, 3);
    assert.equal(set.meta.sealedBy, 'pg-core@0.6.4');
    assert.deepEqual(
      set.containers.map((c) => `${c.file} ${c.mode} privsig=${c.privateSigning}`),
      [
        'mem.bin memory privsig=false',
        'stream.bin stream privsig=false',
        'mem-privsig.bin memory privsig=true',
        'stream-privsig.bin stream privsig=true',
      ]
    );
  });

  it('leaves every writer crate editable rather than freezing it as corpus', () => {
    for (const tooling of [
      'fixtures/gen/src/main.rs',
      'fixtures/gen-0-6-4/src/main.rs',
      'fixtures/gen-0-6-4/Cargo.toml',
      'fixtures/gen-0-6-4/Cargo.lock',
      'fixtures/corpus.test.mjs',
      'fixtures/verify.test.mjs',
    ]) {
      assert.equal(isCorpusPath(tooling), false, tooling);
    }
  });
});

describe('an unsupported schema', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** A throwaway `fixtures/` holding one set, with a copy of corpus.mjs. */
  async function corpusWith(setName, meta) {
    const root = mkdtempSync(join(tmpdir(), 'corpus-schema-'));
    dirs.push(root);
    const fixtures = join(root, 'fixtures');
    mkdirSync(join(fixtures, setName), { recursive: true });
    cpSync(join(FIXTURES, 'corpus.mjs'), join(fixtures, 'corpus.mjs'));
    writeFileSync(join(fixtures, setName, 'meta.json'), JSON.stringify(meta));
    for (const file of ['vk.json', 'usk.json']) {
      writeFileSync(join(fixtures, setName, file), '{}');
    }
    return import(pathToFileURL(join(fixtures, 'corpus.mjs')).href);
  }

  const schema3 = {
    schemaVersion: 3,
    recipientId: 'phd-holder',
    containers: [{ file: 'mem.bin', mode: 'memory', plaintextB64: 'aGk=' }],
  };

  it('is refused by name, naming the set and the version', async () => {
    const corpus = await corpusWith('writer-9.9.9', { ...schema3, schemaVersion: 4 });
    assert.throws(() => corpus.loadSet('writer-9.9.9'), {
      message: /writer-9\.9\.9: meta\.json schemaVersion 4 is newer than this verifier understands/,
    });
    // And it takes the whole run down with it rather than dropping one set:
    // a corpus job that reads nothing and passes is worse than no job.
    assert.throws(() => corpus.fixtureSets(), { message: /schemaVersion 4/ });
  });

  it('is what 3 would be to a verifier that only knew 1 and 2', async () => {
    const corpus = await corpusWith('writer-9.9.9', schema3);
    assert.equal(corpus.loadSet('writer-9.9.9').meta.schemaVersion, 3);
    assert.equal(corpus.loadSet('writer-9.9.9').containers.length, 1);
  });

  /** The same set, plus one container carrying the given tamper block. */
  const withTamper = (tampered) => ({
    ...schema3,
    containers: [
      ...schema3.containers,
      { file: 'mem-spoofed.bin', mode: 'memory', plaintextB64: 'aGk=', tampered },
    ],
  });

  it('is what an unknown tamper kind is: refused, never read as a positive', async () => {
    // Read as a positive it would be a container the corpus asserts opens and
    // reports a sender nobody signed for — the assertion inverted, silently.
    const corpus = await corpusWith(
      'writer-9.9.9',
      withTamper({ kind: 'shaved-yak', swappedFrom: 'mem.bin', attackerEmail: 'a@b.test' })
    );
    assert.throws(() => corpus.loadSet('writer-9.9.9'), {
      message: new RegExp(`unknown tamper kind shaved-yak \\(know ${TAMPER_KINDS.join(', ')}\\)`),
    });
  });

  it('refuses a tamper whose twin the set does not declare', async () => {
    const corpus = await corpusWith(
      'writer-9.9.9',
      withTamper({
        kind: TAMPER_KINDS[0],
        swappedFrom: 'elsewhere.bin',
        attackerEmail: 'a@b.test',
      })
    );
    assert.throws(() => corpus.loadSet('writer-9.9.9'), {
      message: /swappedFrom names elsewhere\.bin, which this set does not declare/,
    });
  });
});
