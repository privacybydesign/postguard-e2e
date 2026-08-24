//! Proof that the expected-failure assertions bite.
//!
//! Three containers in the corpus are supposed to be **rejected**, and each
//! reader has a recorded answer for them (`readers.mjs`, `rejectsTampered`). An
//! assertion that only ever says "as recorded" has not been observed: a
//! negative case that passes because it never really looked is indistinguishable
//! from one that passes because the reader behaved.
//!
//! So each case is run again against a corpus where the **good twin has been
//! put in the tampered container's place**. A good container is a container
//! nothing is wrong with, so every one of these runs has to go red — if one
//! stays green, that expectation was decoration.
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
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
  },
  {
    what: 'a reader that opens it and reports the claim',
    reader: 'pg-wasm',
    container: 'stream-spoofed.bin',
    twin: 'stream.bin',
    red: /should already claim attacker@golden\.test/,
  },
  {
    what: 'a reader that refuses it at the header',
    reader: 'pg-wasm',
    container: 'mem-respelled.bin',
    twin: 'mem.bin',
    red: /recorded as refusing a respelled-sender container at the header/,
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
