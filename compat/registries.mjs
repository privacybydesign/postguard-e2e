// Published-version lookups for the registries compat/manifest.json tracks,
// plus the GitHub file read every entry point here needs.
//
// Shared by check-versions.mjs (does `current` still match what the registry
// serves?), bump-manifest.mjs (move `current` up when it doesn't) and
// check-reader-rows.mjs (are postguard's reader rows still the highest
// published patch of their line?).
import semver from 'semver';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// crates.io asks a bot to identify itself and where to complain about it.
const CRATES_USER_AGENT = 'postguard-e2e-compat (https://github.com/privacybydesign/postguard-e2e)';

/**
 * A file's contents from a GitHub repo, as text.
 *
 * The repos read here are public, so the token is optional and only raises the
 * rate limit. `err.status` is set because a 404 means the path is gone and the
 * fix is an edit here, not a retry — callers word that case differently.
 */
export async function ghFile(repo, path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: {
      Accept: 'application/vnd.github.raw',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${repo}/${path}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/** The registry + package id an `sdk` manifest entry points at. */
export function registryOf(spec) {
  if (spec.npm) return { kind: 'npm', pkg: spec.npm };
  if (spec.nuget) return { kind: 'nuget', pkg: spec.nuget };
  throw new Error(`manifest sdk entry has neither "npm" nor "nuget": ${JSON.stringify(spec)}`);
}

/** Package id as a human reads it, for log lines and PR bodies. */
export function packageName(spec) {
  return registryOf(spec).pkg;
}

async function npmPackument(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!res.ok) throw new Error(`npm registry ${pkg}: ${res.status}`);
  return res.json();
}

/** The `latest` dist-tag of an npm package. */
export async function npmLatest(pkg) {
  const json = await npmPackument(pkg);
  return json['dist-tags']?.latest;
}

/** Every version published for an npm package, in no particular order. */
export async function npmVersions(pkg) {
  const json = await npmPackument(pkg);
  return Object.keys(json.versions ?? {});
}

/**
 * The highest published stable version of a NuGet package.
 *
 * NuGet has no `latest` pointer: the flat-container index lists every version
 * ever pushed, prereleases included and not necessarily sorted the way semver
 * sorts. So pick the maximum stable one ourselves. Versions NuGet accepts but
 * semver does not (the 4-part `1.0.0.1` form) are dropped rather than guessed at.
 *
 * The caller only hears about that when EVERY version is unparseable, which
 * returns null. A 4-part release published alongside 3-part ones is invisible:
 * `highestStable(['0.5.0', '0.6.0.1'])` is `'0.5.0'` and nothing says 0.6.0.1
 * was dropped, so both the check and the bump call that entry up to date.
 * `E4A.PostGuard` is 3-part throughout today; revisit if that changes.
 */
export async function nugetLatest(pkg) {
  const id = encodeURIComponent(pkg.toLowerCase());
  const res = await fetch(`https://api.nuget.org/v3-flatcontainer/${id}/index.json`);
  if (!res.ok) throw new Error(`NuGet ${pkg}: ${res.status}`);
  const json = await res.json();
  return highestStable(json.versions ?? []);
}

/**
 * Every version published for a crate, yanked ones dropped.
 *
 * crates.io refuses a request that sends no `User-Agent` (403, with the reason
 * in `errors`), and the refusal looks exactly like an unpublished crate from
 * the payload alone — neither answer has a `versions` key. So the header is
 * mandatory and the two cases are told apart here, or a refused request reads
 * as "this crate was never published".
 *
 * The endpoint is the crate's version list, whose payload is
 * `{ versions: [ { num, yanked, ... } ] }` and has no `crate` key.
 */
export async function cratesVersions(pkg) {
  const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}/versions`, {
    headers: { 'User-Agent': CRATES_USER_AGENT },
  });
  const json = await res.json().catch(() => null);
  const detail = json?.errors?.[0]?.detail?.split('\n')[0];
  if (!res.ok) {
    throw new Error(`crates.io ${pkg}: ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  if (!Array.isArray(json?.versions)) {
    throw new Error(
      `crates.io ${pkg}: no "versions" in the response${detail ? ` — ${detail}` : ''} ` +
        `(keys: ${json ? Object.keys(json).join(', ') || 'none' : 'not JSON'})`
    );
  }
  return json.versions.filter((v) => !v.yanked).map((v) => v.num);
}

/**
 * The release line a version belongs to: `0.6` for `0.6.5`, `2` for `2.3.3`.
 *
 * Which is what a support window counts in — postguard's COMPATIBILITY.md keeps
 * "the last two minors" of `pg-core` (0.x) and "the last two majors" of
 * `@e4a/pg-js` (2.x, 1.x). Null for anything semver cannot parse.
 */
export function lineOf(version) {
  const v = semver.parse(version);
  if (!v) return null;
  return v.major === 0 ? `0.${v.minor}` : String(v.major);
}

/**
 * Highest published release in the same line as `version` (null if none).
 *
 * Not the same question as `latest`: a reader row pins the highest patch of
 * EACH line in the window, so with 0.6.5 published, a row pinning 0.5.10 is
 * current and only 0.5.11 would make it stale.
 */
export function highestInLine(versions, version) {
  const line = lineOf(version);
  if (line === null) return null;
  return highestStable(versions.filter((v) => lineOf(v) === line));
}

/** Highest non-prerelease, semver-parseable version in a list (null if none). */
export function highestStable(versions) {
  const stable = versions.filter((v) => semver.valid(v) && !semver.prerelease(v));
  if (!stable.length) return null;
  return stable.sort(semver.rcompare)[0];
}

/** Latest published version for an `sdk` manifest entry, whatever its registry. */
export async function latestFor(spec) {
  const { kind, pkg } = registryOf(spec);
  return kind === 'npm' ? npmLatest(pkg) : nugetLatest(pkg);
}
