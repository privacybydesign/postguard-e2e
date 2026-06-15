import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickJsAdapter } from './js/adapters/index.mjs';
import { canRunFlow } from './config.mjs';
import { run, parseResult, trimErr, envForFlow } from './spawn.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxRoot = join(repoRoot, '.sandbox', 'js');

/**
 * Install one published @e4a/pg-js version in an isolated sandbox and run the
 * matching flow against the configured target. Returns a result row:
 *   { client, version, install, run, error, sentClientVersion }
 * where `run` is one of: pass | fail | no_adapter | skipped_no_api_key | skip
 */
export async function runJsVersion(version, config) {
  const result = {
    client: 'js',
    version,
    install: 'n/a',
    run: 'n/a',
    error: null,
    sentClientVersion: null,
  };

  const adapter = pickJsAdapter(version);
  if (!adapter) {
    result.run = 'no_adapter';
    result.error = `no adapter matches ${version}`;
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
    copyFileSync(adapter.flowFile, join(dir, 'flow.mjs'));
  } catch (e) {
    result.install = 'fail';
    result.error = `sandbox setup: ${e.message}`;
    return result;
  }

  const install = await run('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir });
  if (install.code !== 0) {
    result.install = 'fail';
    result.error = trimErr(install.stderr || install.stdout);
    return result;
  }
  result.install = 'ok';

  if (!canRunFlow(config)) {
    result.run = 'skipped_no_api_key';
    return result;
  }

  const out = await run(process.execPath, ['flow.mjs'], { cwd: dir, env: envForFlow(config) });
  const parsed = parseResult(out.stdout);
  result.sentClientVersion = parsed?.sentClientVersion ?? null;
  if (out.code === 0 && parsed?.ok) {
    result.run = 'pass';
  } else {
    result.run = 'fail';
    result.error = parsed?.error || trimErr(out.stderr) || `exit ${out.code}`;
  }
  return result;
}
