//! Append-only gate: nothing under `fixtures/` that is a golden artifact may be
//! modified, deleted or renamed relative to the merge base. Adding is fine —
//! adding is the entire way the corpus grows.
//!
//! ```text
//! node append-only.mjs [<base-ref>]     # default: origin/main
//! ```
//!
//! The comparison is against `git merge-base <base-ref> HEAD`, not against the
//! base branch tip: a branch that is merely behind `main` must not be told it
//! deleted the fixtures someone else added in the meantime.
//!
//! Two things are protected, and they need each other:
//!
//! 1. every corpus file — a modification or deletion is a violation;
//! 2. `CORPUS.sha256` itself — its existing lines are immutable, so "edit the
//!    fixture and its digest together" fails here even though each half looks
//!    consistent on its own.
//!
//! Tooling under `fixtures/` (the verifiers, this gate, the README, the
//! package files, the `gen*/` writer crates) is deliberately NOT protected: the
//! gates have to stay editable or the corpus could never gain a reader.
//! `corpus.mjs` owns that distinction so every gate draws the line in exactly
//! the same place.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isCorpusPath, REPO_ROOT } from './corpus.mjs';
import { parseLedger } from './ledger.mjs';

const LEDGER_REPO_PATH = 'fixtures/CORPUS.sha256';

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * Parse `git diff --name-status -M -z` output into `{status, paths}` records.
 * NUL-separated, and a rename or copy is followed by two paths rather than one.
 */
export function parseNameStatus(raw) {
  const fields = raw.split('\0').filter((f) => f !== '');
  const out = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    const twoPaths = status.startsWith('R') || status.startsWith('C');
    const paths = [fields[i++]];
    if (twoPaths) paths.push(fields[i++]);
    out.push({ status, paths });
  }
  return out;
}

/**
 * Which diff entries violate the rule.
 *
 * Pure, so the rule can be tested without a repository: every status other than
 * `A` (added) is a violation when it touches a corpus path, and a rename counts
 * against its source path too — renaming a fixture is deleting it under its old
 * name, and old name is how a ten-year-old bug report refers to it.
 */
export function violations(entries) {
  const found = [];
  for (const { status, paths } of entries) {
    const [from, to] = paths;
    if (status === 'A') continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (isCorpusPath(from)) {
        found.push({ path: from, what: `renamed to ${to}`, status });
      }
      continue;
    }
    if (!isCorpusPath(from)) continue;
    const what =
      status === 'D' ? 'deleted' : status === 'M' ? 'modified' : `changed (git status ${status})`;
    found.push({ path: from, what, status });
  }
  return found;
}

/**
 * Lines of the ledger that the head revision changed or dropped. Adding lines
 * is how a new fixture set is recorded, so only the existing ones are frozen.
 */
export function ledgerViolations(baseText, headText) {
  const base = parseLedger(baseText, `${LEDGER_REPO_PATH} (merge base)`);
  const head = parseLedger(headText, LEDGER_REPO_PATH);
  const found = [];
  for (const [path, hash] of base) {
    if (!head.has(path)) found.push({ path, what: 'its ledger line was removed' });
    else if (head.get(path) !== hash) found.push({ path, what: 'its ledger digest was rewritten' });
  }
  return found;
}

function fileAt(rev, path) {
  try {
    // stderr silenced: a path that does not exist at a revision is an expected
    // answer here (the ledger is new), not something to print `fatal:` about.
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function main() {
  const baseRef = process.argv[2] ?? process.env.PG_APPEND_ONLY_BASE ?? 'origin/main';

  let mergeBase;
  try {
    mergeBase = git('merge-base', baseRef, 'HEAD').trim();
  } catch (e) {
    console.error(
      `cannot find the merge base of ${baseRef} and HEAD: ${e.message.trim()}\n` +
        'A shallow clone has no common ancestor to compare against, so the gate would pass ' +
        'without checking anything. Fetch the base ref (actions/checkout fetch-depth: 0).'
    );
    process.exitCode = 1;
    return;
  }

  const entries = parseNameStatus(git('diff', '--name-status', '-M', '-z', mergeBase, 'HEAD'));
  const found = violations(entries);

  const baseLedger = fileAt(mergeBase, LEDGER_REPO_PATH);
  const headLedger = fileAt('HEAD', LEDGER_REPO_PATH);
  if (baseLedger !== null) {
    if (headLedger === null) {
      found.push({ path: LEDGER_REPO_PATH, what: 'deleted' });
    } else {
      found.push(...ledgerViolations(baseLedger, headLedger));
    }
  }

  const added = entries.filter((e) => e.status === 'A' && isCorpusPath(e.paths[0])).length;
  console.log(`append-only: comparing HEAD against merge base ${mergeBase.slice(0, 12)} (${baseRef})`);
  console.log(`             ${added} corpus file(s) added, ${found.length} violation(s)`);

  if (found.length > 0) {
    console.error('');
    for (const { path, what } of found) console.error(`  ${path}: ${what}`);
    console.error(
      '\nThe fixture corpus is append-only. Each artifact is a ciphertext someone may still ' +
        'have to open in ten years, so it is never edited and never deleted — a new format, a ' +
        'new writer or a corrected sample is a NEW directory alongside the old one. ' +
        'See fixtures/README.md.'
    );
    process.exitCode = 1;
    return;
  }
  console.log('OK: every change under fixtures/ is an addition');
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
