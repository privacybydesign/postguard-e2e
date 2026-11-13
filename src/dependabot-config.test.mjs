// This repo's own guard on .github/dependabot.yml (postguard#254, graduated to
// postguard-e2e#59, carried over from renovate.json when the repo moved to
// privacybydesign): a rule telling the bot to leave a pin alone is only as good
// as a check that goes red when the rule is removed (postguard#419). The pins
// this repo ignores are compat/manifest.json and the COUPLED_PINS it moves in
// lockstep (compat/bump-manifest.mjs), fixtures/package.json's
// deliberately-uncoupled @e4a/pg-wasm pin, and the corpus writer crates'
// append-only pg-core pins under fixtures/gen and fixtures/gen-0-6-4 — a bot
// bump on any of those silently undoes a compat gate rather than failing loudly.
//
// No YAML parser: the harness has one dependency and this is not a reason for a
// second. The file is split on its `- package-ecosystem:` entries and each
// entry is checked as text, which is enough for "this entry names that
// dependency under `ignore:`".
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, '.github', 'dependabot.yml');

/** `{ ecosystem: entryText }`, comments stripped. */
const entries = () => {
  const text = readFileSync(configPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const out = {};
  for (const chunk of text.split(/^  - package-ecosystem: /m).slice(1)) {
    const name = chunk.split(/[\s#]/, 1)[0];
    assert.ok(!(name in out), `dependabot.yml has two "${name}" entries; this test reads one per ecosystem`);
    out[name] = chunk;
  }
  return out;
};

/** The dependency names an entry lists under `ignore:`. */
const ignored = (entry) => {
  const block = entry.match(/^    ignore:\n((?:      .*\n)+)/m)?.[1] ?? '';
  return [...block.matchAll(/dependency-name: ["']?([^"'\n]+)["']?/g)].map((m) => m[1]);
};

test('dependabot.yml covers every ecosystem this repo has manifests for', () => {
  const found = Object.keys(entries()).sort();
  assert.deepEqual(found, ['cargo', 'github-actions', 'gomod', 'npm']);
});

test('dependabot.yml leaves the first-party npm pins to the compat machinery', () => {
  const { npm } = entries();
  assert.ok(
    ignored(npm).includes('@e4a/*'),
    'the npm entry no longer ignores "@e4a/*". Without it, Dependabot would bump compat/manifest.json ' +
      "out of step with the COUPLED_PINS it moves in lockstep, or age fixtures' deliberately-uncoupled " +
      '@e4a/pg-wasm pin on its own',
  );
});

test('dependabot.yml leaves the corpus writer crates their pg-core pins', () => {
  const { cargo } = entries();
  for (const name of ['pg-core', 'pg-wasm']) {
    assert.ok(
      ignored(cargo).includes(name),
      `the cargo entry no longer ignores "${name}". The writer crates under fixtures/gen and ` +
        'fixtures/gen-0-6-4 pin it exactly, and those pins are append-only history',
    );
  }
});

test('every directory dependabot.yml names exists', () => {
  const text = Object.values(entries()).join('\n');
  const dirs = [
    ...[...text.matchAll(/^    directory: (\S+)/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^    directories: \[(.*)\]/gm)].flatMap((m) =>
      m[1].split(',').map((d) => d.trim().replace(/["']/g, '')),
    ),
  ];
  assert.ok(dirs.length > 0, 'no directory found in dependabot.yml; the patterns in this test are stale');
  for (const dir of dirs) {
    assert.ok(existsSync(join(repoRoot, dir)), `dependabot.yml names ${dir}, which does not exist`);
  }
});
