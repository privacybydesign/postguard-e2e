// isMain() has to survive being run through a symlink, because that is how the
// idiom it replaces fails: on macOS `os.tmpdir()` is /var/folders/… which is a
// symlink to /private/var/folders/…, so a script spawned from a temp directory
// compared its unresolved `import.meta.url` against node's resolved argv[1],
// decided it was not the entry point, ran nothing and exited 0. A test that
// spawns a runner from a temp dir sees a silent success.
//
// The symlinked path is built explicitly here so the case is covered on every
// platform rather than only on the one where tmpdir happens to be one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './is-main.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A script that prints whether it thinks it is the entry point. */
function scriptSource() {
  return [
    `import { isMain } from ${JSON.stringify(join(here, 'is-main.mjs'))};`,
    "console.log(isMain(import.meta.url) ? 'main' : 'not-main');",
    '',
  ].join('\n');
}

test('a script run through its real path is main', () => {
  const root = mkdtempSync(join(tmpdir(), 'is-main-'));
  try {
    const script = join(root, 'runner.mjs');
    writeFileSync(script, scriptSource());
    const out = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(out.stdout.trim(), 'main', out.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a script run through a symlinked directory is still main', () => {
  const root = mkdtempSync(join(tmpdir(), 'is-main-'));
  try {
    const real = join(root, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'runner.mjs'), scriptSource());
    const link = join(root, 'link');
    symlinkSync(real, link, 'dir');

    const out = spawnSync(process.execPath, [join(link, 'runner.mjs')], { encoding: 'utf8' });
    assert.equal(out.stdout.trim(), 'main', out.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an imported module is not main', () => {
  // This test file is what node was asked to run, so is-main.mjs itself is not.
  assert.equal(isMain(new URL('is-main.mjs', import.meta.url).href), false);
});

test('a missing entry point is not main, rather than a crash', () => {
  const argv = process.argv[1];
  try {
    process.argv[1] = join(tmpdir(), 'does-not-exist', 'runner.mjs');
    assert.equal(isMain(import.meta.url), false);
  } finally {
    process.argv[1] = argv;
  }
});
