// Regression tests for the Cargo-parsing / version-matching helpers in
// check-versions.mjs. These cover the two robustness gaps raised in review on
// PR #16: the Rust path must treat Cargo pins as ranges (not exact strings),
// and parseIrmaDep must recognise the `[dependencies.irmars]` table form.
//
// Plus the producer check's remedy line: it may only send a reader to
// `npm run bump` for a mismatch bump-manifest.mjs would actually act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';
import {
  parseIrmaDep,
  cargoReqToRange,
  sdkVerdict,
  consumerVerdict,
  readFailureMessage,
} from './check-versions.mjs';
import { classifyEntry } from './bump-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));

test('cargoReqToRange: a bare version is caret (Cargo default), not exact', () => {
  assert.equal(cargoReqToRange('0.2.2'), '^0.2.2');
  assert.equal(cargoReqToRange('0.2'), '^0.2');
  assert.equal(cargoReqToRange('1'), '^1');
});

test('cargoReqToRange: explicit operators are preserved', () => {
  assert.equal(cargoReqToRange('^0.2.2'), '^0.2.2');
  assert.equal(cargoReqToRange('~0.2'), '~0.2');
  assert.equal(cargoReqToRange('=0.2.2'), '=0.2.2');
  assert.equal(cargoReqToRange('*'), '*');
});

test('cargoReqToRange: comma-joined comparators become a space-joined range', () => {
  assert.equal(cargoReqToRange('>=0.2, <0.4'), '>=0.2 <0.4');
});

test('Rust version check no longer reports false drift for caret / newer patch', () => {
  // The bug: `dep.version === current` flagged these as drift. With ranges they resolve.
  assert.ok(semver.satisfies('0.2.3', cargoReqToRange('0.2')));
  assert.ok(semver.satisfies('0.2.3', cargoReqToRange('0.2.2')));
  assert.ok(semver.satisfies('0.2.2', cargoReqToRange('0.2.2')));
  // Genuinely incompatible pins are still rejected.
  assert.ok(!semver.satisfies('0.3.0', cargoReqToRange('0.2.2')));
  assert.ok(!semver.satisfies('0.2.1', cargoReqToRange('=0.2.2')));
});

test('parseIrmaDep: inline forms', () => {
  assert.deepEqual(parseIrmaDep('irma = "0.2.1"\n'), { crate: 'irma', version: '0.2.1' });
  assert.deepEqual(parseIrmaDep('irmars = "0.2.2"\n'), { crate: 'irmars', version: '0.2.2' });
  assert.deepEqual(
    parseIrmaDep('irma = { package = "irmars", version = "0.2.2" }\n'),
    { crate: 'irmars', version: '0.2.2' }
  );
});

test('parseIrmaDep: [dependencies.irmars] table-section form', () => {
  const toml = [
    '[package]',
    'name = "demo"',
    '',
    '[dependencies.irmars]',
    'version = "0.2.2"',
    'features = ["foo"]',
    '',
    '[dev-dependencies]',
    'anyhow = "1"',
  ].join('\n');
  assert.deepEqual(parseIrmaDep(toml), { crate: 'irmars', version: '0.2.2' });
});

test('parseIrmaDep: table-section form with a package rename', () => {
  const toml = [
    '[dependencies.irma]',
    'package = "irmars"',
    'version = "0.2.2"',
  ].join('\n');
  assert.deepEqual(parseIrmaDep(toml), { crate: 'irmars', version: '0.2.2' });
});

test('parseIrmaDep: table-section header stops at the next section', () => {
  const toml = [
    '[dependencies.irmars]',
    '',
    '[dependencies.serde]',
    'version = "1.0"',
  ].join('\n');
  assert.deepEqual(parseIrmaDep(toml), { crate: 'irmars', version: null });
});

test('parseIrmaDep: returns null when no irma dependency is present', () => {
  assert.equal(parseIrmaDep('[dependencies]\nserde = "1.0"\n'), null);
});

// --- The producer check must not ask for a bump the bumper will not make ---

const dotnet = { name: 'pg-dotnet', pkg: 'E4A.PostGuard', current: '0.5.0' };

test('sdkVerdict: a matching version is a note', () => {
  const v = sdkVerdict({ ...dotnet, latest: '0.5.0' });
  assert.equal(v.level, 'note');
  assert.match(v.message, /matches manifest/);
});

test('sdkVerdict: a newer stable release is drift, and `npm run bump` clears it', () => {
  const v = sdkVerdict({ ...dotnet, latest: '0.6.0' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /Run `npm run bump`/);
  // The instruction is only honest if the bumper agrees it would move this.
  assert.equal(classifyEntry('0.6.0', dotnet.current).action, 'bump');
});

test('sdkVerdict: a prerelease on the `latest` dist-tag is a note, not a permanent red', () => {
  // planBumps skips prereleases and exits 0, so a red here could never clear:
  // no bump PR is opened and the instruction to run one does nothing.
  const v = sdkVerdict({ name: 'pg-js', pkg: '@e4a/pg-js', current: '2.3.3', latest: '2.4.0-rc.1' });
  assert.equal(v.level, 'note');
  assert.doesNotMatch(v.message, /npm run bump/);
  assert.match(v.message, /2\.4\.0-rc\.1 is a prerelease/);
  assert.equal(classifyEntry('2.4.0-rc.1', '2.3.3').code, 'latest-prerelease');
});

test('sdkVerdict: an unusable registry answer stays red but does not promise a bump', () => {
  for (const latest of [null, '1.0.0.1']) {
    const v = sdkVerdict({ ...dotnet, latest });
    assert.equal(v.level, 'problem');
    assert.doesNotMatch(v.message, /Run `npm run bump`/);
    assert.match(v.message, /leaves this entry alone/);
  }
});

test('sdkVerdict: an unparseable `current` stays red and names itself as the cause', () => {
  const v = sdkVerdict({ ...dotnet, current: '0.5.0.1', latest: '0.6.0' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /current 0\.5\.0\.1 is not a semver version/);
});

test('sdkVerdict: a registry older than the manifest stays red, since bumps only ratchet up', () => {
  const v = sdkVerdict({ ...dotnet, latest: '0.4.1' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /0\.4\.1 is older than current 0\.5\.0/);
  assert.equal(classifyEntry('0.4.1', dotnet.current).action, 'none');
});

// --- SDK consumers: a monorepo member is checked for the workspace link ---

const member = {
  name: 'postguard-website',
  repo: 'encryption4all/postguard-js',
  manifest: 'apps/website/package.json',
  dep: '@e4a/pg-js',
  expect: 'workspace',
};
const external = {
  name: 'postguard-outlook-addon',
  repo: 'encryption4all/postguard-outlook-addon',
  manifest: 'package.json',
  dep: '@e4a/pg-js',
};

test('consumerVerdict: a workspace link on a monorepo member is a note', () => {
  const v = consumerVerdict({ consumer: member, spec: 'workspace:*', current: '2.3.4' });
  assert.equal(v.level, 'note');
  assert.match(v.message, /is a workspace link ✓/);
});

test('consumerVerdict: the other pnpm workspace specifiers count as links too', () => {
  for (const spec of ['workspace:*', 'workspace:^', 'workspace:~', 'workspace:^1.2.3']) {
    assert.equal(consumerVerdict({ consumer: member, spec, current: '2.3.4' }).level, 'note');
  }
});

test('consumerVerdict: a member that regressed to a fixed pin is drift', () => {
  // The whole point of the new shape: a `workspace:*` dep cannot drift, so the
  // regression worth catching is the pin that reintroduces drift. Note that
  // 2.3.4 IS the current SDK, so the version question would have said "fine".
  const v = consumerVerdict({ consumer: member, spec: '2.3.4', current: '2.3.4' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /no longer a workspace link/);
  assert.match(v.message, /workspace:\*/);
});

test('consumerVerdict: a member on a caret range is drift as well', () => {
  const v = consumerVerdict({ consumer: member, spec: '^2.3.0', current: '2.3.4' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /no longer a workspace link/);
});

test('consumerVerdict: the ratchet applies to members — known drift is a note', () => {
  const drifted = { ...member, knownDrift: { issue: 'org/repo#1', reason: 'mid-migration' } };
  const v = consumerVerdict({ consumer: drifted, spec: '2.3.4', current: '2.3.4' });
  assert.equal(v.level, 'note');
  assert.match(v.message, /NOT a workspace link — known drift \(org\/repo#1\)/);
});

test('consumerVerdict: a member whose knownDrift is fixed must clean the allowlist', () => {
  const drifted = { ...member, knownDrift: { issue: 'org/repo#1', reason: 'mid-migration' } };
  const v = consumerVerdict({ consumer: drifted, spec: 'workspace:*', current: '2.3.4' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /drift is FIXED/);
});

test('consumerVerdict: external consumers keep the version-range behaviour', () => {
  const ok = consumerVerdict({ consumer: external, spec: '^2.3.0', current: '2.3.4' });
  assert.equal(ok.level, 'note');
  assert.match(ok.message, /resolves 2\.3\.4 ✓/);

  const bad = consumerVerdict({ consumer: external, spec: '^1.10.0', current: '2.3.4' });
  assert.equal(bad.level, 'problem');
  assert.match(bad.message, /cannot resolve current 2\.3\.4/);

  const known = { ...external, knownDrift: { issue: 'org/repo#125', reason: 'needs v1→v2' } };
  const tracked = consumerVerdict({ consumer: known, spec: '^1.10.0', current: '2.3.4' });
  assert.equal(tracked.level, 'note');
  assert.match(tracked.message, /CANNOT resolve 2\.3\.4 — known drift/);

  const fixed = consumerVerdict({ consumer: known, spec: '^2.3.0', current: '2.3.4' });
  assert.equal(fixed.level, 'problem');
  assert.match(fixed.message, /drift is FIXED/);
});

test('consumerVerdict: a consumer that dropped the dep is a problem', () => {
  for (const c of [member, external]) {
    const v = consumerVerdict({ consumer: c, spec: undefined, current: '2.3.4' });
    assert.equal(v.level, 'problem');
    assert.match(v.message, /does not declare @e4a\/pg-js/);
  }
});

test('consumerVerdict: an unknown `expect` value fails instead of silently version-checking', () => {
  const v = consumerVerdict({ consumer: { ...member, expect: 'wokspace' }, spec: '2.3.4', current: '2.3.4' });
  assert.equal(v.level, 'problem');
  assert.match(v.message, /unknown "expect" value "wokspace"/);
});

// --- A manifest path that no longer exists must fail loudly ---

test('readFailureMessage: a 404 names the entry as monitoring nothing', () => {
  const err = new Error('GitHub encryption4all/postguard-js/apps/website/package.json: 404');
  err.status = 404;
  const msg = readFailureMessage(member, err);
  assert.match(msg, /does not exist \(GitHub 404\)/);
  assert.match(msg, /monitors nothing/);
  assert.match(msg, /encryption4all\/postguard-js\/apps\/website\/package\.json/);
});

test('readFailureMessage: any other read failure still reports the cause', () => {
  const err = new Error('GitHub x/y: 500');
  err.status = 500;
  assert.match(readFailureMessage(member, err), /could not read apps\/website\/package\.json \(GitHub x\/y: 500\)/);
  assert.match(readFailureMessage(member, new Error('fetch failed')), /\(fetch failed\)/);
});

// --- The manifest itself must point at live files, not archived ones ---

const consumerByName = Object.fromEntries(manifest.sdkConsumers.map((c) => [c.name, c]));

test('manifest: the consolidated apps are read from the monorepo, not their archived repos', () => {
  // All three apps live in postguard-js now and all three source repos are
  // archived. Reading an old repo was a permanent silent-green
  // (encryption4all/postguard-e2e#30) — and note the shape of the outlook case,
  // because it is the one this test was originally written without. An archived
  // repo is read-only, not deleted, so its package.json keeps resolving: the
  // read never 404s, `readFailureMessage` never fires, and the stale ^1.10.0 pin
  // was reported as covered knownDrift indefinitely. Silent-green survives a
  // repo being archived precisely because nothing about the fetch changes.
  assert.deepEqual(
    { repo: consumerByName['postguard-website'].repo, manifest: consumerByName['postguard-website'].manifest },
    { repo: 'encryption4all/postguard-js', manifest: 'apps/website/package.json' }
  );
  assert.deepEqual(
    { repo: consumerByName['postguard-tb-addon'].repo, manifest: consumerByName['postguard-tb-addon'].manifest },
    { repo: 'encryption4all/postguard-js', manifest: 'apps/tb-addon/package.json' }
  );
  assert.deepEqual(
    {
      repo: consumerByName['postguard-outlook-addon'].repo,
      manifest: consumerByName['postguard-outlook-addon'].manifest,
    },
    { repo: 'encryption4all/postguard-js', manifest: 'apps/outlook-addon/package.json' }
  );
  for (const name of ['postguard-website', 'postguard-tb-addon', 'postguard-outlook-addon']) {
    assert.equal(consumerByName[name].expect, 'workspace');
  }
});

test('manifest: no sdkConsumers entry reads from an archived repository', () => {
  // The five repos folded into postguard-js / postguard and archived in
  // encryption4all/postguard#288-#291 and #293. Archiving does not break a read,
  // so this has to be asserted rather than discovered.
  const archived = [
    'encryption4all/postguard-website',
    'encryption4all/postguard-tb-addon',
    'encryption4all/postguard-outlook-addon',
    'encryption4all/postguard-examples',
    'encryption4all/cryptify',
  ];
  for (const c of manifest.sdkConsumers) {
    assert.ok(!archived.includes(c.repo), `${c.name}: reads from archived ${c.repo}`);
  }
});

test('manifest: every sdkConsumers entry is a shape consumerVerdict understands', () => {
  for (const c of manifest.sdkConsumers) {
    assert.ok(c.name && c.repo && c.manifest && c.dep, `incomplete entry: ${JSON.stringify(c)}`);
    if ('expect' in c) assert.equal(c.expect, 'workspace', `${c.name}: unsupported expect`);
    if (c.knownDrift) assert.ok(c.knownDrift.issue && c.knownDrift.reason, `${c.name}: knownDrift needs issue + reason`);
  }
});
