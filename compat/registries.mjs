// Published-version lookups for the registries compat/manifest.json tracks.
//
// Shared by check-versions.mjs (does `current` still match what the registry
// serves?) and bump-manifest.mjs (move `current` up when it doesn't).
import semver from 'semver';

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

/** The `latest` dist-tag of an npm package. */
export async function npmLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  if (!res.ok) throw new Error(`npm registry ${pkg}: ${res.status}`);
  const json = await res.json();
  return json['dist-tags']?.latest;
}

/**
 * The highest published stable version of a NuGet package.
 *
 * NuGet has no `latest` pointer: the flat-container index lists every version
 * ever pushed, prereleases included and not necessarily sorted the way semver
 * sorts. So pick the maximum stable one ourselves. Versions NuGet accepts but
 * semver does not (the 4-part `1.0.0.1` form) are ignored rather than guessed
 * at — the caller reports the package as unresolvable instead of bumping to
 * something wrong.
 */
export async function nugetLatest(pkg) {
  const id = encodeURIComponent(pkg.toLowerCase());
  const res = await fetch(`https://api.nuget.org/v3-flatcontainer/${id}/index.json`);
  if (!res.ok) throw new Error(`NuGet ${pkg}: ${res.status}`);
  const json = await res.json();
  return highestStable(json.versions ?? []);
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
