import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LEGS } from './matrix.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportDir = join(repoRoot, 'report');

function legMark(leg) {
  if (!leg) return '—';
  switch (leg.outcome) {
    case 'pass':
      return '✅ pass';
    case 'fail':
      return '❌ fail';
    case 'documented_refusal':
      return '➖ no reader (asserted)';
    case 'skipped_no_api_key':
      return '⏭ skipped (no API key)';
    case 'skipped_install_failed':
      return '⏭ skipped (install failed)';
    case 'no_leg':
      return '⚠ no leg';
    default:
      return leg.outcome;
  }
}

/** Everything a row has to say about why it looks the way it does. */
function notes(row) {
  const seen = new Set();
  const messages = [];
  for (const message of [row.error, ...LEGS.map((leg) => row.legs?.[leg]?.error)]) {
    if (!message || seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages.join(' · ').replace(/\|/g, '\\|');
}

function sentClientVersion(row) {
  const sent = row.legs?.wire?.sentClientVersion;
  return sent ? `\`${sent}\`` : '—';
}

function mdTable(rows) {
  if (!rows.length) return '_(no versions swept)_';
  const head =
    '| version | install | wire | decrypt | client-version sent | notes |\n' +
    '|---|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| \`${r.version}\` | ${r.install} | ${legMark(r.legs?.wire)} | ${legMark(
          r.legs?.decrypt
        )} | ${sentClientVersion(r)} | ${notes(r)} |`
    )
    .join('\n');
  return `${head}\n${body}`;
}

function csvField(s) {
  if (s == null) return '';
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Writes report/matrix.{md,csv,json}.
 *
 * The JSON is what `gate.mjs` reads: the sweep and the gates are separate steps
 * so a failed gate cannot take the other gate's verdict with it, and that means
 * the verdicts have to be derivable from a file rather than from the sweep's
 * memory. The CSV is one row per leg, because a version now has more than one
 * outcome and a column per leg would break every reader on the next leg added.
 */
export function writeReport(results, config, run = {}) {
  mkdirSync(reportDir, { recursive: true });
  const when = new Date().toISOString();

  const md = `# PostGuard version-matrix report

- Generated: ${when}
- Profile: ${run.profile ? `\`${run.profile}\` (target: ${run.target})` : '_(none — manual sweep)_'}
- Target PKG: \`${config.pkgUrl}\`
- Target Cryptify: \`${config.cryptifyUrl}\`
- API key: ${config.apiKey ? 'set' : '**not set** — wire legs were skipped (install/compile only)'}
- Support matrix: @e4a/pg-js \`${config.jsVersions}\` (${config.jsVersionsSource}), E4A.PostGuard \`${config.dotnetVersions}\` (${config.dotnetVersionsSource})
${
  run.decrypt
    ? `- Decrypt legs: artifact sealed by \`@e4a/pg-wasm@${run.decrypt.sealerVersion}\` into the ` +
      `\`${run.decrypt.universe}\` key universe (recipient \`${run.decrypt.recipientId}\`)`
    : '- Decrypt legs: not run'
}
${(run.notSwept ?? [])
  .map(
    ({ client, why }) =>
      `- **Not swept: ${client}** — ${why}. Every gate below is red on it: a client with no ` +
      'rows is a support window this run says nothing about.'
  )
  .join('\n')}

> **wire** — the non-interactive server-facing path against the target above:
> params → encrypt with API-key signing → upload → download/inspect. This is
> what a server change can break.
>
> **decrypt** — an old published SDK opening an artifact the new stack sealed.
> It needs no server: a user secret key only exists after a Yivi disclosure, so
> the artifact is sealed into a committed fixture set's key universe and the
> published SDK's own decrypt path runs against a stub serving that set's keys
> (see \`src/keys.mjs\`). The live-server decryption path is covered by the
> yivi-driver's real-SDK flow in \`e2e.yml\`.
>
> The \`X-POSTGUARD-CLIENT-VERSION\` column is what the harness observed the
> client send locally (older versions predating that feature send nothing). The
> authoritative record is always the server's own logs/metrics.

## @e4a/pg-js

${mdTable(results.js)}

## E4A.PostGuard (.NET)

${mdTable(results.dotnet)}

## Outcomes

- **install**: \`ok\` / \`fail\` — npm install (pg-js) or dotnet build/restore (.NET).
  A \`fail\` here on an old version usually means the published version no longer
  installs/compiles, not that the server broke it.
- **pass** — the leg ran and everything it asserts held.
- **fail** with \`install=ok\` is the interesting case: the version installs but
  the leg breaks. That pinpoints the breakage boundary — for \`wire\` against
  this target, for \`decrypt\` against what the new stack now writes.
- **no reader (asserted)** — the published .NET SDK exposes no decrypt API. The
  leg asserts that absence rather than skipping it, and turns red the day the
  SDK grows one.
- **skipped** — the leg did not run (no API key, or the version no longer
  installs). Under a profile this is a failure, not a pass: a leg that quietly
  did not run is the coverage loss these gates exist to catch.
`;

  writeFileSync(join(reportDir, 'matrix.md'), md);

  const rows = [...results.js, ...results.dotnet];
  const csv = [
    'client,version,install,leg,outcome,sent_client_version,error',
    ...rows.flatMap((r) =>
      Object.entries(r.legs ?? {}).map(([leg, value]) =>
        [
          r.client,
          csvField(r.version),
          r.install,
          leg,
          value.outcome,
          csvField(value.sentClientVersion ?? ''),
          csvField(value.error ?? r.error ?? ''),
        ].join(',')
      )
    ),
  ].join('\n');
  writeFileSync(join(reportDir, 'matrix.csv'), csv + '\n');

  const json = {
    generated: when,
    profile: run.profile ?? null,
    target: run.target ?? null,
    legs: run.legs ?? [],
    decrypt: run.decrypt ?? null,
    // Clients that were in scope and produced no row. gate.mjs cannot infer
    // this from `results` — an empty list there is indistinguishable from a
    // client nobody asked for — so the sweep states it.
    notSwept: run.notSwept ?? [],
    config: {
      pkgUrl: config.pkgUrl,
      cryptifyUrl: config.cryptifyUrl,
      apiKey: Boolean(config.apiKey),
      jsVersions: config.jsVersions,
      dotnetVersions: config.dotnetVersions,
    },
    results,
  };
  writeFileSync(join(reportDir, 'matrix.json'), JSON.stringify(json, null, 2) + '\n');

  return {
    md: join(reportDir, 'matrix.md'),
    csv: join(reportDir, 'matrix.csv'),
    json: join(reportDir, 'matrix.json'),
    markdown: md,
  };
}
