//! Proof that the expected-failure assertions bite.
//!
//! Three containers in the corpus are supposed to be **rejected**, and each
//! reader has a recorded answer for them (`readers.mjs`, `rejectsTampered`). An
//! assertion that only ever says "as recorded" has not been observed: a
//! negative case that passes because it never really looked is indistinguishable
//! from one that passes because the reader behaved.
//!
//! So each case is run again twice, against a corpus damaged in the two ways
//! that would let a negative case pass without looking:
//!
//! - the **good twin put in the tampered container's place**. A good container
//!   is a container nothing is wrong with, so a reader recorded as rejecting
//!   must not reject it.
//! - the container **zeroed**. A broken container makes every reader throw, and
//!   a rejection recorded without a message to match would report that throw as
//!   the tamper being caught.
//!
//! Every one of these runs has to go red — if one stays green, that expectation
//! was decoration.
//!
//! Mutating the reader instead is not available here: the readers are published
//! tarballs. `../fixtures-verify/` covers that side, where `pg-core` is a path
//! dependency and the check itself can be deleted to watch the corpus notice.
//!
//! The damaged corpus is a copy in a temporary directory, with copies of the
//! three verifier modules beside it. Copies rather than symlinks: `corpus.mjs`
//! derives `FIXTURES` from its own location, and a symlink resolves back to the
//! real corpus — the one directory a test must never write to.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSet } from './corpus.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(FIXTURES);

/** The set holding the expected-failure class. */
const SET = 'pg-core-0.6.4-tampered';

/**
 * One case per recorded shape of expectation, so each of the three is put to
 * the same test rather than only the one that is easiest to break.
 */
const CASES = [
  {
    what: 'a reader that rejects the tamper',
    reader: 'pg-wasm-0-6-4',
    container: 'mem-spoofed.bin',
    twin: 'mem.bin',
    // Assertion 3 is the one a good container fails first: it claims the real
    // sender, so there is nothing for `unseal` to be asked about.
    red: /should already claim attacker@golden\.test/,
    // Zeroed, it never reaches the tamper assertions at all: the header does
    // not parse, and nothing in this reader's path swallows that.
    redWhenBroken: /does not start with the expected prelude/,
  },
  {
    what: 'a reader that opens it and reports the claim',
    reader: 'pg-wasm',
    container: 'stream-spoofed.bin',
    twin: 'stream.bin',
    red: /should already claim attacker@golden\.test/,
    redWhenBroken: /does not start with the expected prelude/,
  },
  {
    what: 'a reader that refuses it at the header',
    reader: 'pg-wasm',
    container: 'mem-respelled.bin',
    twin: 'mem.bin',
    red: /recorded as refusing a respelled-sender container at the header/,
    // The case that has to match the recorded message rather than merely
    // catching: this reader refuses the container before it reads anything, so
    // the refusal is the only evidence there is, and a broken container
    // produces one too.
    redWhenBroken: /expected the header refusal readers\.mjs records/,
  },
];

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway corpus holding one set, damaged by `damage`. */
function corpusWith(setName, damage) {
  const root = mkdtempSync(join(tmpdir(), 'corpus-teeth-'));
  roots.push(root);

  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  for (const file of ['corpus.mjs', 'readers.mjs', 'verify.mjs']) {
    copyFileSync(join(FIXTURES, file), join(fixtures, file));
  }
  // The published readers themselves, so the copies above run the real thing.
  symlinkSync(join(FIXTURES, 'node_modules'), join(fixtures, 'node_modules'), 'dir');
  // `readers.mjs` reads the current pg-js version out of the repository root,
  // which for these copies is the temporary directory.
  mkdirSync(join(root, 'compat'));
  copyFileSync(join(REPO_ROOT, 'compat', 'manifest.json'), join(root, 'compat', 'manifest.json'));

  cpSync(join(FIXTURES, setName), join(fixtures, setName), { recursive: true });
  damage(join(fixtures, setName));
  return fixtures;
}

/** Runs one verifier case against a throwaway corpus. */
function runCase(fixtures, reader, setName, container) {
  const child = spawnSync(
    process.execPath,
    [join(fixtures, 'verify.mjs'), '--case', reader, setName, container],
    { encoding: 'utf8', timeout: 300_000 }
  );
  return {
    ok: child.status === 0,
    report: `${child.stdout ?? ''}${child.stderr ?? ''}`.trim(),
  };
}

describe('the corpus as committed', () => {
  it('declares three tampered containers, each naming a twin in the same set', () => {
    const set = loadSet(SET);
    const tampered = set.containers.filter((c) => c.tampered);
    assert.deepEqual(
      tampered.map((c) => `${c.file} ${c.tampered.kind} from ${c.tampered.swappedFrom}`),
      [
        'mem-spoofed.bin swapped-signer from mem.bin',
        'stream-spoofed.bin swapped-signer from stream.bin',
        'mem-respelled.bin respelled-sender from mem.bin',
      ]
    );
    // The plaintext is not vestigial on a tampered container: the readers that
    // predate the fix do decrypt these, and recovering exactly what was sealed
    // is part of what is recorded about them.
    for (const container of tampered) {
      const twin = set.containers.find((c) => c.file === container.tampered.swappedFrom);
      assert.ok(container.plaintext.equals(twin.plaintext), container.file);
    }
  });

  for (const { what, reader, container } of CASES) {
    it(`is read as recorded by ${what} (${reader}, ${container})`, () => {
      // The control for the damaged runs below: without it, a red run down
      // there could be the corpus rather than the damage.
      const fixtures = corpusWith(SET, () => {});
      const { ok, report } = runCase(fixtures, reader, SET, container);
      assert.ok(ok, report);
    });
  }
});

describe('the good twin put in a tampered container’s place', () => {
  for (const { what, reader, container, twin, red } of CASES) {
    it(`is refused by ${what} (${reader}, ${container})`, () => {
      const fixtures = corpusWith(SET, (dir) => {
        copyFileSync(join(dir, twin), join(dir, container));
      });
      const { ok, report } = runCase(fixtures, reader, SET, container);
      assert.equal(
        ok,
        false,
        `${twin} passed as ${container}, so this expectation checks nothing: ${report}`
      );
      assert.match(report, red);
    });
  }
});

/**
 * The other direction, and the one a good twin cannot reach: a container that
 * is merely **broken**. Every reader throws on one, and a recorded rejection
 * that only catches would report that throw as the tamper being caught — which
 * is a negative case passing on bytes that are not the tamper at all.
 *
 * Zeroed rather than deleted, so the failure is a reader refusing a container
 * and not a corpus missing a file.
 */
describe('a merely broken container put in a tampered container’s place', () => {
  for (const { what, reader, container, redWhenBroken } of CASES) {
    it(`is not read as the tamper by ${what} (${reader}, ${container})`, () => {
      const fixtures = corpusWith(SET, (dir) => {
        const size = statSync(join(dir, container)).size;
        writeFileSync(join(dir, container), Buffer.alloc(size));
      });
      const { ok, report } = runCase(fixtures, reader, SET, container);
      assert.equal(
        ok,
        false,
        `${container} zeroed still passed, so this expectation is satisfied by any throw: ${report}`
      );
      assert.match(report, redWhenBroken);
    });
  }
});
