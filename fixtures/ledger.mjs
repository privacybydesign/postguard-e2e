//! The corpus digest ledger: `CORPUS.sha256`, one `sha256  path` line per
//! committed golden artifact.
//!
//! ```text
//! node ledger.mjs           # check the corpus against the ledger
//! node ledger.mjs --write   # rewrite it after appending a set
//! ```
//!
//! Why this exists next to the append-only diff check, which already refuses a
//! modified fixture: the diff check needs a merge base, so it only speaks on a
//! pull request. The ledger needs nothing — it is recomputed on every run of
//! every event, including the nightly schedule and a push straight to `main`.
//! An edit that arrives by a route no pull request ever saw still turns this
//! red, forever, which is what makes "these bytes are frozen" a property of the
//! repository rather than of the review process.
//!
//! The two halves cover each other: the ledger says the bytes match what was
//! recorded, and the diff check says the recording itself was only ever
//! appended to. Editing a fixture *and* its ledger line passes the first and
//! fails the second.
//!
//! The file is plain `sha256sum` format, so `sha256sum -c fixtures/CORPUS.sha256`
//! from the repository root is an independent second opinion that needs none of
//! this code.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusFiles, digest, FIXTURES, REPO_ROOT } from './corpus.mjs';

export const LEDGER = join(FIXTURES, 'CORPUS.sha256');
const LEDGER_REPO_PATH = 'fixtures/CORPUS.sha256';

/** Parse `sha256  path` lines into a Map, rejecting anything malformed. */
export function parseLedger(text, source = LEDGER_REPO_PATH) {
  const entries = new Map();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!match) throw new Error(`${source}:${i + 1}: not a "sha256  path" line: ${line}`);
    if (entries.has(match[2])) throw new Error(`${source}:${i + 1}: duplicate path ${match[2]}`);
    entries.set(match[2], match[1]);
  });
  return entries;
}

export function renderLedger(entries) {
  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${hash}  ${path}`)
    .join('\n')
    .concat('\n');
}

/** The ledger the corpus on disk implies. */
export function ledgerFromDisk() {
  return new Map(corpusFiles().map((path) => [path, digest(path)]));
}

/**
 * Compare a recorded ledger against the corpus on disk.
 *
 * @returns {{missing: string[], changed: string[], unrecorded: string[]}}
 *   `missing` — recorded but gone from disk (a deleted fixture);
 *   `changed` — recorded with a different digest (an edited fixture);
 *   `unrecorded` — on disk but not recorded (a fixture added without its line).
 */
export function compare(recorded, onDisk) {
  const missing = [...recorded.keys()].filter((path) => !onDisk.has(path));
  const changed = [...recorded]
    .filter(([path, hash]) => onDisk.has(path) && onDisk.get(path) !== hash)
    .map(([path]) => path);
  const unrecorded = [...onDisk.keys()].filter((path) => !recorded.has(path));
  return { missing, changed, unrecorded };
}

function main() {
  const write = process.argv.includes('--write');
  const onDisk = ledgerFromDisk();

  if (onDisk.size === 0) {
    console.error('the corpus is empty — that itself is a failure');
    process.exitCode = 1;
    return;
  }

  if (write) {
    writeFileSync(LEDGER, renderLedger(onDisk));
    console.log(`wrote ${LEDGER_REPO_PATH}: ${onDisk.size} artifact(s)`);
    console.log(
      'the corpus is append-only: this rewrite may only ever ADD lines. ' +
        'Review the diff before committing.'
    );
    return;
  }

  let recorded;
  try {
    recorded = parseLedger(readFileSync(join(REPO_ROOT, LEDGER_REPO_PATH), 'utf8'));
  } catch (e) {
    console.error(`cannot read the ledger: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const { missing, changed, unrecorded } = compare(recorded, onDisk);
  for (const path of missing) console.error(`DELETED   ${path} — recorded in the ledger, gone from disk`);
  for (const path of changed) console.error(`MODIFIED  ${path} — content no longer matches its recorded digest`);
  for (const path of unrecorded) console.error(`UNRECORDED ${path} — add it with \`npm run ledger:write\``);

  if (missing.length + changed.length + unrecorded.length > 0) {
    console.error(
      '\nThe corpus is append-only. A golden artifact is a ciphertext someone may still ' +
        'have to open in ten years: it is never edited and never removed, only added to. ' +
        'See fixtures/README.md.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`OK: ${onDisk.size} artifact(s) match ${LEDGER_REPO_PATH}`);
}

/**
 * True when this module was executed rather than imported. Compares real paths:
 * on macOS the temp directory the gate's own tests run in is a symlink, so a
 * plain string compare against `process.argv[1]` makes the script import
 * cleanly and then do nothing — a gate that runs and checks nothing.
 */
function runAsScript() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
}

if (runAsScript()) main();
