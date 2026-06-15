import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportDir = join(repoRoot, 'report');

function runMark(run) {
  switch (run) {
    case 'pass':
      return '✅ pass';
    case 'fail':
      return '❌ fail';
    case 'skipped_no_api_key':
      return '⏭ skipped (no API key)';
    case 'no_adapter':
      return '⚠ no adapter';
    default:
      return run;
  }
}

function mdTable(rows) {
  if (!rows.length) return '_(no versions swept)_';
  const head =
    '| version | install | run | client-version sent | notes |\n' +
    '|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| \`${r.version}\` | ${r.install} | ${runMark(r.run)} | ${
          r.sentClientVersion ? `\`${r.sentClientVersion}\`` : '—'
        } | ${r.error ? r.error.replace(/\|/g, '\\|') : ''} |`
    )
    .join('\n');
  return `${head}\n${body}`;
}

function csvField(s) {
  if (s == null) return '';
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function writeReport(results, config) {
  mkdirSync(reportDir, { recursive: true });
  const when = new Date().toISOString();

  const md = `# PostGuard version-matrix report

- Generated: ${when}
- Target PKG: \`${config.pkgUrl}\`
- Target Cryptify: \`${config.cryptifyUrl}\`
- API key: ${config.apiKey ? 'set' : '**not set** — flow runs were skipped (install/compile only)'}

> Tests the non-interactive server-facing path (params → encrypt with API-key
> signing → upload → download/inspect). Decryption needs an interactive Yivi
> session and is not exercised. The authoritative record of the
> \`X-POSTGUARD-CLIENT-VERSION\` each client sent is the server's logs/metrics;
> the column below is what the harness observed locally.

## @e4a/pg-js

${mdTable(results.js)}

## E4A.PostGuard (.NET)

${mdTable(results.dotnet)}

## Outcomes

- **install**: \`ok\` / \`fail\` — npm install (pg-js) or dotnet build/restore (.NET).
  A \`fail\` here on an old version usually means the published version no longer
  installs/compiles, not that the server broke it.
- **run**: \`pass\` / \`fail\` / \`skipped (no API key)\` / \`no adapter\`. A \`fail\`
  with \`install=ok\` is the interesting case — the version installs but the
  encrypt→upload→inspect flow breaks against this target. That pinpoints the
  breakage boundary.
`;

  writeFileSync(join(reportDir, 'matrix.md'), md);

  const rows = [...results.js, ...results.dotnet];
  const csv = [
    'client,version,install,run,sent_client_version,error',
    ...rows.map((r) =>
      [
        r.client,
        csvField(r.version),
        r.install,
        r.run,
        csvField(r.sentClientVersion ?? ''),
        csvField(r.error ?? ''),
      ].join(',')
    ),
  ].join('\n');
  writeFileSync(join(reportDir, 'matrix.csv'), csv + '\n');

  return { md: join(reportDir, 'matrix.md'), csv: join(reportDir, 'matrix.csv') };
}
