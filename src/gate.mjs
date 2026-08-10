// One gate, one question: did every swept version pass this leg?
//
//   node src/gate.mjs --legs wire
//   node src/gate.mjs --legs decrypt
//
// Reads the report `run.mjs` last wrote and exits 1 on a regression. Separate
// from the sweep so the two verdicts are independent: in a workflow the second
// gate runs under `if: ${{ !cancelled() }}` and still reports when the first
// already went red, which is precisely the run where its answer matters.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMain } from './is-main.mjs';
import { resolveLegs } from './matrix.mjs';
import { legVerdict } from './verdict.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPORT_JSON = join(repoRoot, 'report', 'matrix.json');

function parseArgs(argv) {
  const legsIndex = argv.indexOf('--legs');
  const legs = legsIndex === -1 ? null : argv[legsIndex + 1];
  return { legs };
}

function readReport() {
  try {
    return JSON.parse(readFileSync(REPORT_JSON, 'utf8'));
  } catch (e) {
    throw new Error(
      `cannot read ${REPORT_JSON} (${e.message}) — run the sweep first: npm run sweep -- --profile <name>`
    );
  }
}

if (isMain(import.meta.url)) {
  try {
    const { legs } = parseArgs(process.argv.slice(2));
    const report = readReport();
    const wanted = resolveLegs(legs);

    console.log(
      `Gate: ${wanted.join(', ')} — sweep of ${report.profile ?? 'no profile'} against ` +
        `${report.config?.pkgUrl ?? 'unknown target'} (${report.generated ?? 'unknown time'})`
    );

    let red = false;
    for (const leg of wanted) {
      const verdict = legVerdict(report, leg);
      if (verdict.ok) {
        console.log(`  ok    ${leg}: ${verdict.checked} version(s)`);
        continue;
      }
      red = true;
      console.error(
        `  FAIL  ${leg}: ${verdict.failures.length} problem(s) across ${verdict.checked} version(s)`
      );
      for (const failure of verdict.failures) console.error(`          ${failure}`);
    }

    if (red) {
      console.error(
        '\nThis leg did not come back clean. report/matrix.md has the detail; where a supported ' +
          'version failed, that version is the boundary consumers would break on.'
      );
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exitCode = 1;
  }
}
