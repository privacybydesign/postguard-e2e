import { spawn } from 'node:child_process';

/** Run a command, capturing stdout/stderr and the exit code. Never rejects —
 *  a spawn error resolves with code -1 so callers can record an outcome. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function commandExists(cmd) {
  const { code } = await run(cmd, ['--version']);
  return code === 0;
}

export function trimErr(s, n = 400) {
  if (!s) return null;
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Find the last `__RESULT__ <json>` line a flow printed and parse it. */
export function parseResult(stdout) {
  const line = String(stdout)
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('__RESULT__'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('__RESULT__'.length).trim());
  } catch {
    return null;
  }
}

export function envForFlow(config) {
  return {
    ...process.env,
    PG_PKG_URL: config.pkgUrl,
    PG_CRYPTIFY_URL: config.cryptifyUrl,
    PG_API_KEY: config.apiKey,
    PG_CITIZEN_EMAIL: config.citizen,
    PG_ORGANISATION_EMAIL: config.org,
    PG_EMAIL_ATTRIBUTE: config.emailAttribute,
  };
}
