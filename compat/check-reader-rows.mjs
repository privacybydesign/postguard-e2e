// Are postguard's reader rows still current against the registries? (issue #50)
//
// COMPATIBILITY.md in encryption4all/postguard carries a fenced block of reader
// rows — "the highest published patch of each line in the support window" — and
// the compat gates in that repo install exactly those versions. A producer
// publishing a new patch makes a row stale, and nothing in postguard notices:
// it has no scheduled workflow. This repo does, so the watch lives here.
//
//   node compat/check-reader-rows.mjs
//
// Deliberately a separate entry point from check-versions.mjs, and it should
// stay one however tempting the fold-in looks: a red "postguard's reader rows
// are stale" and a red "a consumer repo drifted" are different statements about
// different repos, and neither may mask the other.
//
// Auth: none needed, postguard is public. GH_TOKEN / GITHUB_TOKEN raises the
// rate limit if set.
import { fileURLToPath } from 'node:url';
import { cratesVersions, ghFile, highestInLine, npmVersions } from './registries.mjs';

const SOURCE = { repo: 'encryption4all/postguard', path: 'COMPATIBILITY.md' };

// The block's own first line, which is how it is found among the other fenced
// blocks in that document.
const HEADER = '# <registry> <package> <versions...>';

/** Published-version lookup per registry the rows may name. */
export const BACKENDS = {
  'crates.io': cratesVersions,
  npm: npmVersions,
};

/**
 * The reader rows in a COMPATIBILITY.md, as `{ registry, pkg, versions }`.
 *
 * Throws when the block is missing and when it holds no rows. An empty result
 * would compare equal to nothing and report a clean run, which is exactly the
 * staleness this check exists to catch.
 */
export function parseReaderRows(md) {
  const block = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .find((b) => b.split('\n')[0].trim() === HEADER);
  if (!block) {
    throw new Error(
      `${SOURCE.path} has no fenced block starting with "${HEADER}". ` +
        `The reader list is kept as rows, not prose — check whether it moved or was reworded.`
    );
  }

  const rows = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [registry, pkg, ...versions] = line.split(/\s+/);
    rows.push({ registry, pkg, versions });
  }
  if (!rows.length) {
    throw new Error(
      `${SOURCE.path}: the reader block parsed to zero rows, so this check would pass vacuously.`
    );
  }
  return rows;
}

/**
 * Check each version on each row against its registry.
 *
 * Returns `{ checked, problems }`, both arrays of lines: `checked` is every row
 * looked at, so a green run shows its work. A row whose registry has no
 * backend, or whose lookup fails, is a problem rather than a skip — a check
 * that quietly stops watching a package is worse than no check.
 *
 * `backends` is injected so the tests never reach the network.
 */
export async function checkRows(rows, backends = BACKENDS) {
  const checked = [];
  const problems = [];
  const published = new Map();

  for (const { registry, pkg, versions } of rows) {
    const lookup = backends[registry];
    if (!lookup) {
      problems.push(
        `${pkg} (${registry}): no registry backend, so its ${versions.length} pinned ` +
          `version(s) are unchecked. Add one to compat/registries.mjs.`
      );
      continue;
    }
    if (!versions.length) {
      problems.push(`${pkg} (${registry}): row pins no versions, so it asserts nothing.`);
      continue;
    }

    const key = `${registry} ${pkg}`;
    if (!published.has(key)) {
      try {
        published.set(key, { versions: await lookup(pkg) });
      } catch (e) {
        published.set(key, { error: e.message });
      }
    }
    const answer = published.get(key);
    if (answer.error) {
      problems.push(`${pkg} (${registry}): lookup failed (${answer.error}), so it is unchecked.`);
      continue;
    }

    for (const pinned of versions) {
      const highest = highestInLine(answer.versions, pinned);
      if (highest === null) {
        problems.push(
          `${pkg} (${registry}): pinned ${pinned} has no published release in its line, ` +
            `so nothing confirms it is installable.`
        );
      } else if (highest === pinned) {
        checked.push(`${pkg} ${pinned} (${registry}) is the highest published in its line ✓`);
      } else {
        problems.push(
          `${pkg} (${registry}): the reader row pins ${pinned}, but the highest published ` +
            `release in that line is ${highest}. Move the pin in ${SOURCE.repo}'s ${SOURCE.path}.`
        );
      }
    }
  }

  return { checked, problems };
}

async function main() {
  const rows = parseReaderRows(await ghFile(SOURCE.repo, SOURCE.path));
  const { checked, problems } = await checkRows(rows);

  console.log(`${SOURCE.repo} ${SOURCE.path}: reader rows vs the registries\n`);
  for (const c of checked) console.log(`  · ${c}`);
  if (problems.length) {
    console.log('\nSTALE / UNCHECKED ROWS:');
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`\n${problems.length} problem(s) in ${SOURCE.repo}'s reader list.`);
    process.exit(1);
  }
  console.log('\nEvery reader row is the highest published release of its line.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
