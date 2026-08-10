// What makes a sweep red, in one pure function.
//
// Split from the sweep itself on purpose. Running the sweep is expensive (an
// install per swept version) and answers several questions at once; a gate
// answers ONE question and has to be able to report its verdict even when
// another gate already failed. So `run.mjs` writes the report and exits on
// harness health alone, and `gate.mjs` reads that report once per leg — which is
// what lets the workflow give the second gate `if: ${{ !cancelled() }}` and
// still see its verdict on exactly the runs it exists for.

/**
 * Leg outcomes that are NOT a regression.
 *
 * `documented_refusal` is a recorded absence the sweep asserts rather than
 * skips (the .NET SDK has no reader): green while it holds, and the leg itself
 * turns red the day it stops holding.
 */
const GREEN = new Set(['pass', 'documented_refusal']);

/**
 * Human wording per red outcome. A skip is red, not amber: these legs run under
 * a profile that declares them mandatory, and a leg that silently did not run is
 * the failure mode a deploy-time backstop exists to prevent — the same reason
 * `e2e.yml` fails when a mandatory golden-flow test reports SKIP.
 */
const WHY = {
  fail: 'failed',
  no_leg: 'has no leg for this version — the sweep covered less than it claims',
  skipped_no_api_key: 'did not run: no PG_API_KEY, so only installability was tested',
  skipped_install_failed: 'did not run: the published version no longer installs',
};

/**
 * The clients that were in scope but produced no row at all.
 *
 * A gate judges the rows in the report, so a client that contributed none is
 * invisible to it: with `{js: [passing], dotnet: []}` there is nothing to
 * filter out and nothing to complain about, and the pg-js rows certify the leg
 * on behalf of the client that was never swept. A runner without the .NET SDK
 * is the way that happens by accident.
 *
 * @param {string[]} scope   clients the sweep was asked to cover
 * @param {object}   results { js: row[], dotnet: row[] }
 * @param {object}   why     per-client reason, when the sweep knows one
 */
export function notSweptClients(scope, results, why = {}) {
  return scope
    .filter((client) => (results?.[client] ?? []).length === 0)
    .map((client) => ({ client, why: why[client] ?? 'no version of it was swept' }));
}

/**
 * The verdict for one leg across a report's rows.
 *
 * @param {object} report a parsed report/matrix.json
 * @param {string} leg    'wire' | 'decrypt'
 * @returns {{leg: string, ok: boolean, checked: number, failures: string[]}}
 */
export function legVerdict(report, leg) {
  const rows = [...(report.results?.js ?? []), ...(report.results?.dotnet ?? [])];
  const relevant = rows.filter((row) => row.legs && leg in row.legs);
  const failures = [];

  // Coverage first: a client with no rows cannot be judged by the loop below,
  // so it has to be named here or its whole support window passes unswept.
  for (const { client, why } of report.notSwept ?? []) {
    failures.push(
      `${client} was not swept at all (${why}) — this gate covers none of its support window`
    );
  }

  for (const row of relevant) {
    const { outcome, error } = row.legs[leg];
    if (GREEN.has(outcome)) continue;
    const why = WHY[outcome] ?? `reported ${outcome}`;
    failures.push(`${row.client} ${row.version}: ${why}${error ? ` — ${error}` : ''}`);
  }

  // A leg that matched no row at all is a gate that checked nothing. Reporting
  // success there is exactly the outcome this file exists to refuse.
  if (relevant.length === 0) {
    failures.push(
      `no swept version ran the ${leg} leg — the report covers ${rows.length} version(s), ` +
        'so either the sweep did not run this leg or it swept nothing'
    );
  }

  return { leg, ok: failures.length === 0, checked: relevant.length, failures };
}
