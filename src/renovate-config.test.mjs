// This repo's own guard on renovate.json (encryption4all/postguard#254,
// graduated to encryption4all/postguard-e2e#59): a rule telling Renovate to
// leave a pin alone is only as good as a check that goes red when the rule is
// removed (postguard#419). The pins this repo ignores are compat/manifest.json
// and the COUPLED_PINS it moves in lockstep (compat/bump-manifest.mjs),
// fixtures/package.json's deliberately-uncoupled @e4a/pg-wasm pin, and the
// corpus writer crates' append-only pg-core pins under fixtures-verify — a
// Renovate bump on any of those silently undoes a compat gate rather than
// failing loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, 'renovate.json');

const PRESET = 'github>encryption4all/renovate-config';
const IGNORED_PATHS = ['compat/**', 'fixtures/**', 'fixtures-verify/**'];
const IGNORED_PACKAGES = ['@e4a/**', 'pg-core', 'pg-wasm'];

const config = () => JSON.parse(readFileSync(configPath, 'utf8'));

test('renovate.json extends the fleet preset', () => {
  const { extends: extendsList } = config();
  assert.ok(
    Array.isArray(extendsList) && extendsList.includes(PRESET),
    `renovate.json must extend "${PRESET}" — the shared schedule, grouping and fleet-wide first-party ` +
      `ignores live there, not per-repo`,
  );
});

test('renovate.json ignores the pins other machinery owns', () => {
  const { packageRules } = config();
  assert.ok(Array.isArray(packageRules), 'renovate.json has no packageRules — the local ignore rule is gone');

  const rule = packageRules.find(
    (r) =>
      r.enabled === false &&
      IGNORED_PATHS.every((p) => r.matchFileNames?.includes(p)) &&
      IGNORED_PACKAGES.every((p) => r.matchPackageNames?.includes(p)),
  );

  assert.ok(
    rule,
    `no packageRules entry disables ${JSON.stringify(IGNORED_PACKAGES)} under ` +
      `${JSON.stringify(IGNORED_PATHS)}. Without it, Renovate would bump compat/manifest.json out of ` +
      `step with the COUPLED_PINS it moves in lockstep, age fixtures' deliberately-uncoupled ` +
      `@e4a/pg-wasm pin on its own, or edit the corpus writer crates' append-only pg-core pins`,
  );
});

test('renovate.json never turns automerge on', () => {
  // Recursive: automerge is a valid key at the top level, inside a packageRule,
  // or inside a nested rule set, and a scoped `true` is exactly as dangerous as
  // a top-level one — both PostGuard and postguard-js require a human review a
  // bot cannot give.
  const seenTrue = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'automerge' && value === true) seenTrue.push(path || 'root');
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(config(), '');

  assert.deepEqual(
    seenTrue,
    [],
    `renovate.json sets "automerge": true at ${seenTrue.join(', ')} — no automerge anywhere, ` +
      `a maintainer admin-merges the weekly group by hand`,
  );
});
