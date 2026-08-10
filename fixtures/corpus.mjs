//! What the corpus is, in one place: which paths belong to it, which
//! directories are fixture sets, and what a set's `meta.json` promises.
//!
//! Every gate over `fixtures/` imports this. The append-only check, the digest
//! ledger and the verifiers have to agree on "is this file part of the corpus"
//! down to the last path, because a disagreement is not a bug that shows up as
//! a failure — it is a file that one gate protects and another does not.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of `fixtures/`. */
export const FIXTURES = dirname(fileURLToPath(import.meta.url));

/** Path of the repository root, i.e. `fixtures/..`. */
export const REPO_ROOT = dirname(FIXTURES);

/**
 * `meta.json` layouts the verifiers understand.
 *
 * 1 — the original hand-generated set: two containers (`mem.bin`, `stream.bin`)
 *     and one set-wide `plaintextB64`, with no `containers` list at all.
 * 2 — a `containers` list with a plaintext per container, so a set can carry
 *     more than the two classic files.
 *
 * A schema outside this list is a failure, never a skip. Schema 1 sets can
 * never be migrated to 2 (editing them is what the append-only rule forbids),
 * so both stay supported forever.
 */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

/** Directories directly under `fixtures/` that are tooling, not a fixture set. */
const NOT_A_SET = new Set(['node_modules', 'gen']);

/**
 * Files directly under `fixtures/` that are tooling: the verifiers, their
 * package files, the ledger and this README. Everything else under `fixtures/`
 * is corpus and therefore append-only.
 *
 * Deliberately an allowlist of *tooling*, not of corpus. A new fixture set is
 * added by an author who is thinking about fixtures; a new tooling file is
 * added by someone editing gates, who is the person more likely to notice the
 * list. Getting it the other way round would mean a forgotten entry silently
 * leaves a fixture unprotected.
 */
const TOOLING_FILES = new Set([
  'README.md',
  'CORPUS.sha256',
  'append-only.mjs',
  'append-only.test.mjs',
  'corpus.mjs',
  'ledger.mjs',
  'readers.mjs',
  'verify.mjs',
  'package.json',
  'package-lock.json',
]);

/**
 * Is this path (relative to the repository root, forward slashes) a corpus
 * file — one of the golden artifacts the append-only rule protects?
 *
 * @param {string} repoPath e.g. `fixtures/pg-core-0.6.1/mem.bin`
 */
export function isCorpusPath(repoPath) {
  if (!repoPath.startsWith('fixtures/')) return false;
  const rest = repoPath.slice('fixtures/'.length);
  if (!rest) return false;
  const [head, ...tail] = rest.split('/');
  if (tail.length === 0) return !TOOLING_FILES.has(head);
  return !NOT_A_SET.has(head);
}

/** Every corpus file on disk, as repo-relative paths, sorted. */
export function corpusFiles() {
  const out = [];
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute).sort()) {
      const childAbsolute = join(absolute, entry);
      const childRelative = posix.join(relative, entry);
      if (statSync(childAbsolute).isDirectory()) {
        // A directory is either a fixture set (everything inside is corpus) or
        // tooling (nothing inside is). isCorpusPath decides on the top-level
        // name, so recursion below a set never has to ask again.
        if (isCorpusPath(childRelative)) walk(childAbsolute, childRelative);
        continue;
      }
      if (isCorpusPath(childRelative)) out.push(childRelative);
    }
  };
  walk(FIXTURES, 'fixtures');
  return out.sort();
}

/** sha256 of a file, hex. */
export function digest(repoPath) {
  return createHash('sha256').update(readFileSync(join(REPO_ROOT, repoPath))).digest('hex');
}

/**
 * The fixture sets on disk: one entry per writer directory, with its parsed
 * `meta.json` and the containers it declares.
 */
export function fixtureSets() {
  const sets = readdirSync(FIXTURES)
    .filter((name) => !NOT_A_SET.has(name))
    .filter((name) => statSync(join(FIXTURES, name)).isDirectory())
    .sort()
    .map((name) => loadSet(name));

  if (sets.length === 0) {
    throw new Error(`no fixture sets under ${FIXTURES} — that itself is a failure`);
  }
  return sets;
}

/** Parse one set directory. Throws with the set name on anything malformed. */
export function loadSet(name) {
  const dir = join(FIXTURES, name);
  const read = (file) => readFileSync(join(dir, file), 'utf8');

  let meta;
  try {
    meta = JSON.parse(read('meta.json'));
  } catch (e) {
    throw new Error(`${name}: cannot read meta.json (${e.message})`);
  }

  const schemaVersion = meta.schemaVersion ?? 1;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new Error(
      `${name}: meta.json schemaVersion ${schemaVersion} is newer than this verifier understands ` +
        `(knows ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}) — teach it the new layout rather than skipping the set`
    );
  }

  // Schema 1 has no list: it is exactly the two classic files, public signature
  // only. Spelling the default out is what keeps the corpus append-only — the
  // original set's meta.json can never be edited to add the field.
  const declared = meta.containers ?? [
    { file: 'mem.bin', mode: 'memory' },
    { file: 'stream.bin', mode: 'stream' },
  ];

  const containers = declared.map((container) => {
    const plaintextB64 = container.plaintextB64 ?? meta.plaintextB64;
    if (!plaintextB64) {
      throw new Error(
        `${name}/${container.file}: no plaintextB64 on the container and none set-wide — ` +
          'nothing to compare the decrypted bytes against'
      );
    }
    if (container.mode !== 'memory' && container.mode !== 'stream') {
      throw new Error(`${name}/${container.file}: unknown container mode ${container.mode}`);
    }
    return {
      ...container,
      privateSigning: container.privateSigning ?? false,
      plaintext: Buffer.from(plaintextB64, 'base64'),
    };
  });

  if (containers.length === 0) throw new Error(`${name}: meta.json declares no containers`);

  return {
    name,
    dir,
    meta,
    containers,
    // Raw JSON, because the PKG stub the pg-js reader needs serves these
    // verbatim, and the pg-wasm reader wants the fields inside them.
    verifyingKeyRaw: read('vk.json'),
    uskRaw: read('usk.json'),
    get verifyingKey() {
      return JSON.parse(this.verifyingKeyRaw).publicKey;
    },
    get usk() {
      return JSON.parse(this.uskRaw).key;
    },
  };
}

/** The container a case names, or a clear error naming the set. */
export function findContainer(set, file) {
  const container = set.containers.find((c) => c.file === file);
  if (!container) throw new Error(`${set.name}: meta.json declares no container ${file}`);
  return container;
}
