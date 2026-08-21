// The root CLAUDE.md is orientation, and nothing may refill it.
//
// It was 18,069 B of migrated agent notes at b9eafcc — one `## Agent notes`
// container over fifteen `### area: lesson` sections, none of which said what
// this repo is or which sibling repo a change here touches. Those two halves
// are what the file is for (dobby-code#675, cut by #690); everything else was
// either already written beside the code it describes or is a durable check,
// which now lives as a binding rule delivered per task at ~/dobby-rules.md.
//
// So this is a CONTENT gate as much as a size gate: a file can sit under the
// cap and still be a junk drawer, which is how the corpus grew the first time.
//
// It runs on every pull request: version-sweep.yml's `unit` job is deliberately
// unscoped by `paths:` and runs `npm test`, so a PR touching CLAUDE.md alone
// reaches it. (e2e.yml's path filters do not cover `src/**` — that job is the
// only reason anything here runs in CI at all.)
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const claudeMd = join(repoRoot, 'CLAUDE.md');

// 4,000 B is the gate from dobby-code#482 that decides whether a container
// working this repo gets its cwd pointed at the checkout. Against an
// orientation file landing near 3,500 B that is room to add a sibling repo or
// reword a paragraph, not room for a second corpus. Raising it is a decision,
// not a reflex.
const MAX_BYTES = 4_000;

const body = () => readFileSync(claudeMd, 'utf8');

test('CLAUDE.md stays orientation-sized', () => {
  // Measured LF-normalised, not from stat(): this repo ships no .gitattributes,
  // so a CRLF checkout would otherwise spend ~60 B of the budget on line
  // endings and fail on Windows only.
  const bytes = Buffer.byteLength(body().replace(/\r\n/g, '\n'), 'utf8');
  assert.ok(
    bytes <= MAX_BYTES,
    `CLAUDE.md is ${bytes} B, over the ${MAX_BYTES} B cap. This file is ORIENTATION — what this ` +
      `repo is, the position it takes, and the sibling repos a change here touches. Documentation ` +
      `goes to the README beside the code or to docs.postguard.eu; a durable check goes to the rule ` +
      `bundle (at most 600 B, delivered at ~/dobby-rules.md), not here.`,
  );
});

// Named rather than left to the byte count, because the corpus can start
// growing back one section at a time and stay under the cap for a long while.
// Any heading level: the sections arrived as `###`, and bumping them to `####`
// must not be a way past this.
const CUT_HEADINGS = [
  'Agent notes (migrated from the dobby memory repo)',
  'yivi-driver: what does and does not run locally',
  'yivi-driver: `-race` reports an irmago bug, not ours',
  "yivi-driver: irmago's test-only helpers are in internal/, so they get reimplemented here",
  'yivi-driver: a keyshare session only asks for a PIN once the token ages out',
  "stack/business-db: the schema is postguard-business's, not ours",
  'compat/: the manifest is edited as text, not reserialised',
  'compat/: the bumper edits fixtures/ too, and the job must commit it',
  "fixtures/: the corpus job's JS half runs in the workspace",
  'compat/: an sdkConsumers entry can be a version range or a workspace link',
  'compat/: which mismatches the bumper will act on lives in one place',
  'Workflow `run:` blocks that pipe must set pipefail themselves',
  'src/ tests are not run by CI',
  'src/: the decrypt legs seal into a fixture key universe, and why they must',
  'src/: a gate judges rows, so an absent client is the coverage hole to close',
  'The published .NET SDK has no reader, and no attribute-type override either',
  'Runnable scripts under src/ use isMain(), not the file:// idiom',
];

test('CLAUDE.md has no heading from the cut corpus', () => {
  const headings = [...body().matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(([, h]) => h);
  for (const cut of CUT_HEADINGS) {
    assert.ok(
      !headings.includes(cut),
      `CLAUDE.md has a "${cut}" heading again. That section went out with the corpus at b9eafcc: ` +
        `its content is a README, a source comment or a binding rule now.`,
    );
  }
});

// A gate that only proves absence is satisfied by an empty file, so pin the two
// halves the cut exists to leave behind. The sibling-repo half is the one a
// container cannot derive from this repo alone, which is why it is checked by
// name and not just by word count.
test('CLAUDE.md still carries what orientation is for', () => {
  const text = body();
  assert.match(
    text,
    /^#{1,6}\s+Repos to weigh before changing this one\s*$/m,
    'the sibling-repo section is gone — which other repos a change here touches is the half of ' +
      'orientation that cannot be derived from this repo, and the reason the file exists',
  );
  assert.match(
    text,
    /\bb9eafcc\b/,
    'the archive pointer is gone. The corpus is not migrated and not reconstructed: it stays in ' +
      'git history, and this file names the revision holding it so a reader can `git show <sha>:CLAUDE.md`',
  );
  assert.match(
    text,
    /integration canary/,
    'the position this repo takes is gone — that this harness is where a cross-product break ' +
      'surfaces first is what tells a container how to read a red run here',
  );
});
