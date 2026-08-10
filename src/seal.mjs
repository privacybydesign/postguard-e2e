// The new side of the decrypt legs: seals one fresh artifact that every swept
// published SDK is then asked to open.
//
// "New stack" is the current @e4a/pg-wasm — the layer that owns the container
// format on the JS side and therefore the thing that decides what bytes an
// updated deployment's clients will start producing. Which version is current
// is read from `compat/manifest.json` rather than pinned here, so "current"
// means the same thing to the sweep as it does to the cross-repo drift detector
// and to the archival corpus's reader (`fixtures/readers.mjs`): one definition,
// in the file whose whole job is to hold it.
//
// The direction matters. postguard's own PR-time gate catches HEAD pg-core
// breaking bytes an older writer produced; the corpus under `fixtures/` catches
// current readers breaking committed old bytes. Neither covers a published SDK
// still in the field being handed bytes a NEWER stack sealed — the direction
// that breaks consumers, and the reason issue #21 wants these legs at deploy
// time.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, parseResult, trimErr } from './spawn.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const sandboxDir = join(repoRoot, '.sandbox', 'new-stack');
const sealFlow = join(here, 'js', 'new-stack', 'seal.mjs');

/** The plaintext the fresh artifact carries, so a wrong-file open cannot pass. */
export const SEAL_PLAINTEXT = Buffer.from(
  'postguard-e2e version sweep: sealed by the new stack, must open with every supported SDK'
);

/**
 * The @e4a/pg-wasm version to seal with: PG_SEAL_WITH, else the manifest's
 * current. A version this repo does not track is a deliberate act (probing a
 * release candidate), so it is allowed — but it is printed by run.mjs and
 * recorded in the report, never silent.
 */
export function newStackVersion(env = process.env) {
  if (env.PG_SEAL_WITH) return env.PG_SEAL_WITH;
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'compat', 'manifest.json'), 'utf8'));
  const version = manifest?.sdk?.['pg-wasm']?.current;
  if (!version) throw new Error('compat/manifest.json has no sdk["pg-wasm"].current');
  return version;
}

/**
 * Install the new stack's sealer and seal one artifact into `universe`'s key
 * universe. Returns `{ version, container, bytes }` — the path is what each
 * version's decrypt leg opens.
 *
 * Throws on any failure. A decrypt gate whose artifact never got sealed must
 * fail loudly: "nothing to open" reported as success is the whole failure mode
 * these legs exist to prevent.
 */
export async function sealWithNewStack(universe, env = process.env) {
  const version = newStackVersion(env);
  const container = join(sandboxDir, 'new-stack-sealed.bin');

  rmSync(sandboxDir, { recursive: true, force: true });
  mkdirSync(sandboxDir, { recursive: true });
  writeFileSync(
    join(sandboxDir, 'package.json'),
    JSON.stringify(
      {
        name: 'pg-vm-new-stack',
        private: true,
        type: 'module',
        dependencies: { '@e4a/pg-wasm': version },
      },
      null,
      2
    )
  );
  writeFileSync(join(sandboxDir, 'seal.mjs'), readFileSync(sealFlow));

  const install = await run('npm', ['install', '--no-audit', '--no-fund', '--silent'], {
    cwd: sandboxDir,
  });
  if (install.code !== 0) {
    throw new Error(
      `installing @e4a/pg-wasm@${version} (the new stack's sealer) failed: ` +
        trimErr(install.stderr || install.stdout)
    );
  }

  const job = {
    mpk: universe.mpk,
    policy: universe.policy,
    pubSignKey: universe.signKeys.pubSignKey,
    plaintextB64: SEAL_PLAINTEXT.toString('base64'),
    out: container,
  };
  const sealed = await run(process.execPath, ['seal.mjs'], {
    cwd: sandboxDir,
    env: { ...env, PG_SEAL_JOB: JSON.stringify(job) },
  });
  const parsed = parseResult(sealed.stdout);
  if (sealed.code !== 0 || !parsed?.ok) {
    throw new Error(
      `sealing with @e4a/pg-wasm@${version} into ${universe.name}'s key universe failed: ` +
        (parsed?.error || trimErr(sealed.stderr) || `exit ${sealed.code}`)
    );
  }

  return { version, container, bytes: parsed.bytes };
}
