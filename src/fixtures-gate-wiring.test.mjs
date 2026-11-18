// The repository ruleset requires the `crypto-fixtures` check on `main`, so the
// workflow that owns that job has to report on every pull request.
//
// A job skipped by a `paths:` filter reports no status at all. While this job
// sat in e2e.yml, behind that workflow's pull_request path filter, a pull
// request outside those paths waited on the check forever and could not be
// merged; the ruleset has no bypass. These tests read the workflow files as
// text and hold the two properties that keep the check reporting: exactly one
// workflow defines the job, and its pull_request trigger is unfiltered.
//
// They run on every pull request through version-sweep.yml's `unit` job.
import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflows = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

// Comment lines are dropped first: the workflows explain these very triggers in
// prose, and a match on the prose would prove nothing about the YAML.
const read = (name) =>
  readFileSync(join(workflows, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

// The body of a top-level `on:` entry such as `pull_request:` — the lines
// indented deeper than the key, up to the next key at the same depth.
export function triggerBody(yaml, trigger) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${trigger}:`);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
}

const definesJob = (yaml, job) => yaml.split('\n').includes(`  ${job}:`);

test('triggerBody separates a filtered trigger from an unfiltered one', () => {
  const yaml = "on:\n  push:\n    paths:\n      - 'a/**'\n  pull_request:\n  workflow_dispatch:\n";
  assert.match(triggerBody(yaml, 'push'), /paths:/);
  assert.equal(triggerBody(yaml, 'pull_request').trim(), '');
  assert.equal(triggerBody(yaml, 'schedule'), null);
});

test('exactly one workflow defines the required crypto-fixtures job', () => {
  const owners = readdirSync(workflows)
    .filter((name) => name.endsWith('.yml'))
    .filter((name) => definesJob(read(name), 'crypto-fixtures'));
  assert.deepEqual(
    owners,
    ['fixtures.yml'],
    'the ruleset requires the check named `crypto-fixtures`; a second job of that name in a ' +
      'path-filtered workflow would report under the same name on some pull requests only',
  );
});

test('the crypto-fixtures workflow runs on every pull request', () => {
  const body = triggerBody(read('fixtures.yml'), 'pull_request');
  assert.notEqual(body, null, 'fixtures.yml has no pull_request trigger');
  assert.equal(
    body.trim(),
    '',
    'fixtures.yml filters its pull_request trigger. A filtered-out required check never ' +
      'reports, and every pull request outside the filter becomes unmergeable.',
  );
});

test('the crypto-fixtures job itself is not conditional', () => {
  const lines = read('fixtures.yml').split('\n');
  const start = lines.indexOf('  crypto-fixtures:');
  const jobKeys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break;
    if (/^    \S/.test(line)) jobKeys.push(line.trim().split(':')[0]);
  }
  assert.ok(jobKeys.includes('steps'), 'did not find the job body');
  assert.ok(
    !jobKeys.includes('if'),
    'a job-level `if:` that skips the job reports it as skipped, which a required check ' +
      'accepts as passing: the gate would be green without having run',
  );
});

test('e2e.yml still runs the corpus gate on the events fixtures.yml does not see', () => {
  assert.match(read('e2e.yml'), /\n  corpus:\n    uses: \.\/\.github\/workflows\/fixtures\.yml\n/);
});
