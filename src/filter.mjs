import semver from 'semver';

/**
 * Resolve a version `spec` against the full published `all` list.
 * Spec forms:
 *   "all"        -> every valid (stable) version, ascending
 *   "latest:N"   -> the N highest stable versions, descending
 *   "majors:N"   -> the newest stable release of each of the N highest major
 *                   lines, descending — the support-matrix form (see matrix.mjs)
 *   "1.8.0,1.9"  -> exactly the listed versions that exist
 *   "^1.0.0"     -> every published version satisfying the semver range
 *   "1.8.0"      -> that single version if published (stable or prerelease)
 * Prereleases are excluded unless explicitly named — either in a comma list
 * or as an exact single version.
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

  // "the last N majors" is a support window, not a release count: one entry per
  // major line, so a package that ships ten patches this month does not push
  // the previous major out of the sweep. A 0.x package has one major line, so
  // "majors:1" there is the newest 0.x release and "majors:2" is still one
  // version — 0.x majors are minors, and inventing a second line here would
  // sweep versions nobody declared supported.
  if (spec.startsWith('majors:')) {
    const n = Number.parseInt(spec.slice('majors:'.length), 10) || 1;
    const newestPerMajor = new Map();
    for (const v of semver.rsort([...stable])) {
      const major = semver.major(v);
      if (!newestPerMajor.has(major)) newestPerMajor.set(major, v);
    }
    return [...newestPerMajor.values()].slice(0, n);
  }

  if (spec.includes(',')) {
    const wanted = spec.split(',').map((s) => s.trim()).filter(Boolean);
    return wanted.filter((v) => valid.includes(v));
  }

  // An exact published version wins over range matching. Every exact version
  // is also a valid semver range, so without this the range branch below would
  // swallow it — and because that branch filters `stable`, an exactly named
  // prerelease (e.g. "2.0.0-rc.1") would resolve to nothing.
  if (valid.includes(spec)) {
    return [spec];
  }

  if (semver.validRange(spec)) {
    return semver.sort(stable.filter((v) => semver.satisfies(v, spec)));
  }

  return [];
}
