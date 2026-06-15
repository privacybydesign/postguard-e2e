import semver from 'semver';

/**
 * Resolve a version `spec` against the full published `all` list.
 * Spec forms:
 *   "all"        -> every valid (stable) version, ascending
 *   "latest:N"   -> the N highest stable versions, descending
 *   "1.8.0,1.9"  -> exactly the listed versions that exist
 *   "^1.0.0"     -> every published version satisfying the semver range
 *   "1.8.0"      -> that single version if published
 * Prereleases are excluded unless explicitly named in a comma list.
 */
export function filterVersions(all, spec) {
  const valid = all.filter((v) => semver.valid(v));
  const stable = valid.filter((v) => !semver.prerelease(v));

  if (!spec || spec === 'all') {
    return semver.sort([...stable]);
  }

  if (spec.startsWith('latest:')) {
    const n = Number.parseInt(spec.slice('latest:'.length), 10) || 1;
    return semver.rsort([...stable]).slice(0, n);
  }

  if (spec.includes(',')) {
    const wanted = spec.split(',').map((s) => s.trim()).filter(Boolean);
    return wanted.filter((v) => valid.includes(v));
  }

  if (semver.validRange(spec)) {
    return semver.sort(stable.filter((v) => semver.satisfies(v, spec)));
  }

  return valid.includes(spec) ? [spec] : [];
}
