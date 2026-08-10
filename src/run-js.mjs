import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickJsAdapter } from './js/adapters/index.mjs';
import { canRunFlow } from './config.mjs';
import { run, parseResult, trimErr, envForFlow } from './spawn.mjs';
import { SEAL_PLAINTEXT } from './seal.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxRoot = join(repoRoot, '.sandbox', 'js');

/**
 * Install one published @e4a/pg-js version in an isolated sandbox and run the
 * requested legs against it. Returns a result row:
 *   { client, version, install, error, legs: { <leg>: { outcome, error, … } } }
 * where a leg outcome is one of:
 *   pass | fail | no_leg | skipped_no_api_key | skipped_install_failed
 *
 * The `decrypt` leg needs `decrypt`: the artifact the new stack sealed, and the
 * stub PKG serving the key universe it was sealed into (seal.mjs, keys.mjs).
 */
export async function runJsVersion(version, config, { legs = ['wire'], decrypt = null } = {}) {
  const result = {
    client: 'js',
    version,
    install: 'n/a',
    error: null,
    legs: {},
  };

  const adapter = pickJsAdapter(version);
  if (!adapter) {
    result.error = `no adapter matches ${version}`;
    for (const leg of legs) result.legs[leg] = { outcome: 'no_leg', error: result.error };
    return result;
  }

  const dir = join(sandboxRoot, version);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: `pg-js-vm-${version.replace(/[^a-z0-9.-]/gi, '_')}`,
          private: true,
          type: 'module',
          dependencies: { '@e4a/pg-js': version },
        },
        null,
        2
      )
    );
    for (const leg of legs) {
      if (adapter.legs[leg]) copyFileSync(adapter.legs[leg], join(dir, `${leg}.mjs`));
    }
  } catch (e) {
    result.install = 'fail';
    result.error = `sandbox setup: ${e.message}`;
    for (const leg of legs) {
      result.legs[leg] = { outcome: 'skipped_install_failed', error: result.error };
    }
    return result;
  }

  const install = await run('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir });
  if (install.code !== 0) {
    result.install = 'fail';
    result.error = trimErr(install.stderr || install.stdout);
    for (const leg of legs) {
      result.legs[leg] = { outcome: 'skipped_install_failed', error: result.error };
    }
    return result;
  }
  result.install = 'ok';

  for (const leg of legs) {
    if (!adapter.legs[leg]) {
      result.legs[leg] = { outcome: 'no_leg', error: `adapter ${adapter.name} has no ${leg} leg` };
      continue;
    }
    result.legs[leg] =
      leg === 'wire' ? await wireLeg(dir, config) : await decryptLeg(dir, decrypt, version);
  }

  return result;
}

/** params -> encrypt (API-key signing) -> upload -> download/inspect. */
async function wireLeg(dir, config) {
  if (!canRunFlow(config)) {
    return { outcome: 'skipped_no_api_key', error: null, sentClientVersion: null };
  }
  const out = await run(process.execPath, ['wire.mjs'], { cwd: dir, env: envForFlow(config) });
  const parsed = parseResult(out.stdout);
  const sentClientVersion = parsed?.sentClientVersion ?? null;
  if (out.code === 0 && parsed?.ok) {
    return { outcome: 'pass', error: null, sentClientVersion };
  }
  return {
    outcome: 'fail',
    error: parsed?.error || trimErr(out.stderr) || `exit ${out.code}`,
    sentClientVersion,
  };
}

/** Open the artifact the new stack sealed, with this published version. */
async function decryptLeg(dir, decrypt, version) {
  if (!decrypt) {
    // run.mjs seals before it sweeps, so this is unreachable there. An error
    // rather than a skip, so a future caller that forgets to seal cannot turn
    // the leg into a pass.
    return { outcome: 'fail', error: 'no new-stack artifact was handed to the decrypt leg' };
  }
  const out = await run(process.execPath, ['decrypt.mjs'], {
    cwd: dir,
    // A reader can also hang on a container it disagrees with, and a leg that
    // never returns costs the whole run its report. Same bound the corpus
    // verifier uses; the "died without reporting" branch below covers the kill.
    timeout: 300_000,
    env: {
      ...process.env,
      PG_OPEN_PKG_URL: decrypt.pkgUrl,
      PG_OPEN_CONTAINER: decrypt.container,
      PG_OPEN_RECIPIENT: decrypt.recipientId,
      PG_OPEN_EXPECT_PLAINTEXT_B64: SEAL_PLAINTEXT.toString('base64'),
      PG_OPEN_EXPECT_SENDER: decrypt.senderEmail ?? '',
    },
  });
  const parsed = parseResult(out.stdout);
  if (out.code === 0 && parsed?.ok) {
    return { outcome: 'pass', error: null, sealedBy: decrypt.sealedBy };
  }
  // A reader that no longer agrees with a header layout does not reliably
  // throw: it can read a garbage length prefix and abort on the allocation,
  // which arrives as a dead process and no result line. Say that, or the only
  // evidence is a version that printed nothing.
  const silent = !parsed && !trimErr(out.stderr);
  return {
    outcome: 'fail',
    error:
      parsed?.error ||
      trimErr(out.stderr) ||
      (silent
        ? `@e4a/pg-js ${version} died without reporting (exit ${out.code}) — a reader that no ` +
          'longer agrees with the container header aborts rather than throws'
        : `exit ${out.code}`),
    sealedBy: decrypt.sealedBy,
  };
}
