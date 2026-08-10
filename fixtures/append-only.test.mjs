//! Proof that the append-only gate bites.
//!
//! The pure-rule tests are the cheap half. The half that matters builds a
//! throwaway git repository with a miniature corpus in it, commits a base,
//! mutates it, and runs `append-only.mjs` and `ledger.mjs` for real — because
//! every way this gate can fail silently lives in the wiring, not in the rule:
//! a merge base resolved wrongly, a path classified as tooling, a diff status
//! nobody thought to handle. A gate that has only ever been observed reporting
//! success has not been observed at all.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isCorpusPath } from './corpus.mjs';
import { ledgerViolations, parseNameStatus, violations } from './append-only.mjs';

const FIXTURES = dirname(fileURLToPath(import.meta.url));

describe('which paths the corpus rule protects', () => {
  it('protects every file inside a fixture set', () => {
    assert.equal(isCorpusPath('fixtures/pg-core-0.6.1/mem.bin'), true);
    assert.equal(isCorpusPath('fixtures/pg-wasm-0.6.1/meta.json'), true);
    assert.equal(isCorpusPath('fixtures/some-future-writer/stream.bin'), true);
  });

  it('leaves the gates themselves editable', () => {
    for (const tooling of [
      'fixtures/README.md',
      'fixtures/verify.mjs',
      'fixtures/corpus.mjs',
      'fixtures/ledger.mjs',
      'fixtures/append-only.mjs',
      'fixtures/package.json',
      'fixtures/package-lock.json',
      'fixtures/gen/src/main.rs',
      'fixtures/gen/Cargo.toml',
    ]) {
      assert.equal(isCorpusPath(tooling), false, tooling);
    }
  });

  it('protects the ledger as data even though it sits with the tooling', () => {
    // Not a corpus path (it is regenerated when a set is appended), but frozen
    // line by line — see ledgerViolations.
    assert.equal(isCorpusPath('fixtures/CORPUS.sha256'), false);
  });

  it('ignores everything outside fixtures/', () => {
    assert.equal(isCorpusPath('fixtures-verify/src/main.rs'), false);
    assert.equal(isCorpusPath('.github/workflows/e2e.yml'), false);
  });
});

describe('the rule itself', () => {
  it('allows additions and refuses everything else', () => {
    const entries = parseNameStatus(
      ['A', 'fixtures/new-writer/mem.bin', 'M', 'fixtures/pg-wasm-0.6.1/mem.bin', 'D', 'fixtures/pg-wasm-0.6.1/stream.bin', 'M', 'fixtures/verify.mjs'].join('\0')
    );
    assert.deepEqual(
      violations(entries).map((v) => `${v.path}: ${v.what}`),
      ['fixtures/pg-wasm-0.6.1/mem.bin: modified', 'fixtures/pg-wasm-0.6.1/stream.bin: deleted']
    );
  });

  it('counts a rename as a deletion of the old name', () => {
    const entries = parseNameStatus(
      ['R100', 'fixtures/pg-wasm-0.6.1/mem.bin', 'fixtures/pg-wasm-0.6.1/memory.bin'].join('\0')
    );
    assert.deepEqual(
      violations(entries).map((v) => v.path),
      ['fixtures/pg-wasm-0.6.1/mem.bin']
    );
  });

  it('freezes existing ledger lines but allows new ones', () => {
    const base = `${'a'.repeat(64)}  fixtures/one/mem.bin\n`;
    const appended = `${base}${'b'.repeat(64)}  fixtures/two/mem.bin\n`;
    assert.deepEqual(ledgerViolations(base, appended), []);
    assert.deepEqual(ledgerViolations(base, `${'c'.repeat(64)}  fixtures/one/mem.bin\n`), [
      { path: 'fixtures/one/mem.bin', what: 'its ledger digest was rewritten' },
    ]);
    assert.deepEqual(ledgerViolations(base, ''), [
      { path: 'fixtures/one/mem.bin', what: 'its ledger line was removed' },
    ]);
  });
});

describe('the gate, run for real against a git repository', () => {
  const repos = [];
  after(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  /** A throwaway repo holding a two-file corpus plus the real gate scripts. */
  function repoWithCorpus() {
    const repo = mkdtempSync(join(tmpdir(), 'corpus-gate-'));
    repos.push(repo);
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });

    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'gate@test.invalid');
    git('config', 'user.name', 'gate');

    mkdirSync(join(repo, 'fixtures', 'writer-1.0.0'), { recursive: true });
    for (const file of ['corpus.mjs', 'ledger.mjs', 'append-only.mjs']) {
      cpSync(join(FIXTURES, file), join(repo, 'fixtures', file));
    }
    writeFileSync(join(repo, 'fixtures', 'writer-1.0.0', 'mem.bin'), 'golden memory bytes');
    writeFileSync(join(repo, 'fixtures', 'writer-1.0.0', 'stream.bin'), 'golden stream bytes');
    writeFileSync(join(repo, 'fixtures', 'verify.mjs'), '// a gate, not a fixture\n');
    execFileSync(process.execPath, [join(repo, 'fixtures', 'ledger.mjs'), '--write'], {
      encoding: 'utf8',
    });

    git('add', '-A');
    git('commit', '-qm', 'base: the corpus as it stands');
    const base = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-b', 'change');
    return { repo, git, base };
  }

  /** Run a gate script inside the repo and return `{code, output}`. */
  function run(repo, script, args = []) {
    try {
      const stdout = execFileSync(process.execPath, [join(repo, 'fixtures', script), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { code: 0, output: stdout };
    } catch (e) {
      return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('stays green when a new fixture set is added', () => {
    const { repo, git, base } = repoWithCorpus();
    mkdirSync(join(repo, 'fixtures', 'writer-2.0.0'));
    writeFileSync(join(repo, 'fixtures', 'writer-2.0.0', 'mem.bin'), 'new golden bytes');
    run(repo, 'ledger.mjs', ['--write']);
    git('add', '-A');
    git('commit', '-qm', 'append a writer');

    const appendOnly = run(repo, 'append-only.mjs', [base]);
    assert.equal(appendOnly.code, 0, appendOnly.output);
    const ledger = run(repo, 'ledger.mjs');
    assert.equal(ledger.code, 0, ledger.output);
  });

  it('turns red when a fixture is deleted', () => {
    const { repo, git, base } = repoWithCorpus();
    rmSync(join(repo, 'fixtures', 'writer-1.0.0', 'stream.bin'));
    git('add', '-A');
    git('commit', '-qm', 'drop a fixture');

    const appendOnly = run(repo, 'append-only.mjs', [base]);
    assert.equal(appendOnly.code, 1, appendOnly.output);
    assert.match(appendOnly.output, /writer-1\.0\.0\/stream\.bin: deleted/);

    // And the ledger catches it independently, with no merge base in sight.
    const ledger = run(repo, 'ledger.mjs');
    assert.equal(ledger.code, 1, ledger.output);
    assert.match(ledger.output, /DELETED\s+fixtures\/writer-1\.0\.0\/stream\.bin/);
  });

  it('turns red when a fixture is modified', () => {
    const { repo, git, base } = repoWithCorpus();
    writeFileSync(join(repo, 'fixtures', 'writer-1.0.0', 'mem.bin'), 'tampered bytes');
    git('add', '-A');
    git('commit', '-qm', 'edit a fixture');

    const appendOnly = run(repo, 'append-only.mjs', [base]);
    assert.equal(appendOnly.code, 1, appendOnly.output);
    assert.match(appendOnly.output, /writer-1\.0\.0\/mem\.bin: modified/);

    const ledger = run(repo, 'ledger.mjs');
    assert.equal(ledger.code, 1, ledger.output);
    assert.match(ledger.output, /MODIFIED\s+fixtures\/writer-1\.0\.0\/mem\.bin/);
  });

  it('turns red when a fixture and its ledger line are rewritten together', () => {
    const { repo, git, base } = repoWithCorpus();
    writeFileSync(join(repo, 'fixtures', 'writer-1.0.0', 'mem.bin'), 'tampered bytes');
    run(repo, 'ledger.mjs', ['--write']); // the cover-up
    git('add', '-A');
    git('commit', '-qm', 'edit a fixture and its digest');

    // The ledger is self-consistent again, which is exactly why it alone is
    // not enough.
    const ledger = run(repo, 'ledger.mjs');
    assert.equal(ledger.code, 0, ledger.output);

    const appendOnly = run(repo, 'append-only.mjs', [base]);
    assert.equal(appendOnly.code, 1, appendOnly.output);
    assert.match(appendOnly.output, /writer-1\.0\.0\/mem\.bin: modified/);
    assert.match(appendOnly.output, /ledger digest was rewritten/);
  });

  it('lets the gates themselves be edited', () => {
    const { repo, git, base } = repoWithCorpus();
    writeFileSync(join(repo, 'fixtures', 'verify.mjs'), '// a better gate\n');
    git('add', '-A');
    git('commit', '-qm', 'improve a verifier');

    const appendOnly = run(repo, 'append-only.mjs', [base]);
    assert.equal(appendOnly.code, 0, appendOnly.output);
  });

  it('refuses to pass when it cannot find a merge base', () => {
    const { repo } = repoWithCorpus();
    const appendOnly = run(repo, 'append-only.mjs', ['no-such-ref']);
    assert.equal(appendOnly.code, 1, appendOnly.output);
    assert.match(appendOnly.output, /cannot find the merge base/);
  });

  it('rejects a malformed ledger rather than reading past it', () => {
    const { repo } = repoWithCorpus();
    writeFileSync(join(repo, 'fixtures', 'CORPUS.sha256'), 'not a digest line\n');
    const ledger = run(repo, 'ledger.mjs');
    assert.equal(ledger.code, 1, ledger.output);
    assert.match(ledger.output, /not a "sha256 {2}path" line/);
  });

  it('records every corpus file, keys and metadata included', () => {
    const { repo } = repoWithCorpus();
    const recorded = readFileSync(join(repo, 'fixtures', 'CORPUS.sha256'), 'utf8');
    assert.match(recorded, /fixtures\/writer-1\.0\.0\/mem\.bin/);
    assert.match(recorded, /fixtures\/writer-1\.0\.0\/stream\.bin/);
    assert.doesNotMatch(recorded, /verify\.mjs/);
  });
});
