// The support matrix the sweep runs, and the two profiles it runs it under.
//
// The matrix is a declaration of what PostGuard promises to keep working, so it
// lives in one file as data rather than in a workflow's `matrix:` block: the
// nightly, the pre-deploy gate and a maintainer sweeping by hand must all sweep
// the same set, and a version window that only exists in YAML cannot be
// unit-tested or read by the report.
//
// Decided in issue #21:
//   - @e4a/pg-js:     the last TWO majors (the SDK websites and add-ons ship)
//   - E4A.PostGuard:  the last major
//   - nightly    -> the edge deployment
//   - pre-deploy -> the candidate server images, i.e. the local stack built from
//                   the postguard checkout under test (`stack/`)
//
// Both profiles run both legs. The wire leg needs the target server; the
// decrypt legs do not (see keys.mjs), which is why a missing API key can cost
// the wire verdict but never silently takes the decrypt verdict with it.

/** Version-filter specs (see filter.mjs) that define the supported window. */
export const SUPPORT_MATRIX = {
  js: 'majors:2',
  dotnet: 'majors:1',
};

/**
 * Where a profile points the sweep, and which legs it holds mandatory.
 *
 * `pkgUrl`/`cryptifyUrl` are defaults: PG_PKG_URL / PG_CRYPTIFY_URL still win,
 * because the candidate stack does not always sit on localhost (a runner that
 * booted it in a service container, a maintainer probing a review deployment).
 * run.mjs prints the effective target, so an override is visible rather than
 * silent.
 *
 * `emailAttribute` overrides the attribute types the SDK addresses recipients
 * with (postguard#236). The candidate stack issues irma-demo credentials and
 * runs its PKG with PKG_EMAIL_ATTRIBUTE=irma-demo.sidn-pbdf.email.email, so the
 * sweep has to speak the same type there. Versions published before that config
 * option existed ignore it and address the production types — that is a real
 * finding about those versions against a test-scheme deployment, not a harness
 * bug, and the report says which version sent what.
 */
export const PROFILES = {
  nightly: {
    target: 'edge',
    pkgUrl: 'https://pkg.staging.postguard.eu',
    cryptifyUrl: 'https://storage.staging.postguard.eu',
    emailAttribute: '',
    requires: ['wire', 'decrypt'],
  },
  'pre-deploy': {
    target: 'candidate',
    pkgUrl: 'http://localhost:8087',
    cryptifyUrl: 'http://localhost:8000',
    emailAttribute: 'irma-demo.sidn-pbdf.email.email',
    requires: ['wire', 'decrypt'],
  },
};

/** Every leg the sweep knows how to run, in report order. */
export const LEGS = ['wire', 'decrypt'];

export function profileNames() {
  return Object.keys(PROFILES);
}

/**
 * The named profile, or a clear error. Never falls back to a default: a
 * mistyped profile in a workflow would otherwise sweep the wrong target and
 * report success about a deployment nobody asked about.
 */
export function resolveProfile(name) {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`unknown profile "${name}" (have ${profileNames().join(', ')})`);
  }
  return { name, ...profile };
}

/**
 * Which legs to run this time, from a `--legs` list. Unknown names fail rather
 * than being dropped: a typo would otherwise run fewer legs than asked and
 * still report success.
 */
export function resolveLegs(spec) {
  if (!spec) return [...LEGS];
  const wanted = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((leg) => !LEGS.includes(leg));
  if (unknown.length > 0) {
    throw new Error(`unknown leg(s) ${unknown.join(', ')} (have ${LEGS.join(', ')})`);
  }
  if (wanted.length === 0) throw new Error('--legs was given but names no leg');
  return wanted;
}
