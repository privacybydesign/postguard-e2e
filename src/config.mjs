// Reads run configuration from the environment (see config.example.env) and,
// when a profile is named, from the support matrix (see matrix.mjs).
//
// A profile supplies defaults, the environment overrides them, and every field
// records where its value came from — because "which versions did the nightly
// actually sweep, against what" is the first question asked of a red run, and a
// silently overridden target answers it wrong.

import { SUPPORT_MATRIX, resolveProfile } from './matrix.mjs';

/** Where a version filter came from, in the words the report prints. */
function specSource(source, envName, profile) {
  if (source === envName) return envName;
  return profile ? 'support matrix' : 'default';
}

export function loadConfig({ profile = null, env = process.env } = {}) {
  const p = profile ? resolveProfile(profile) : null;

  const pick = (envName, profileValue, fallback) => {
    if (env[envName]) return { value: env[envName], source: envName };
    if (profileValue) return { value: profileValue, source: p ? `profile ${p.name}` : 'default' };
    return { value: fallback, source: 'default' };
  };

  const pkgUrl = pick('PG_PKG_URL', p?.pkgUrl, 'https://pkg.staging.postguard.eu');
  const cryptifyUrl = pick('PG_CRYPTIFY_URL', p?.cryptifyUrl, 'https://storage.staging.postguard.eu');
  const jsVersions = pick('PG_JS_VERSIONS', p ? SUPPORT_MATRIX.js : null, 'latest:5');
  const dotnetVersions = pick('PG_DOTNET_VERSIONS', p ? SUPPORT_MATRIX.dotnet : null, 'latest:5');
  const emailAttribute = pick('PG_EMAIL_ATTRIBUTE', p?.emailAttribute, '');

  return {
    profile: p?.name ?? null,
    target: p?.target ?? null,
    pkgUrl: pkgUrl.value,
    pkgUrlSource: pkgUrl.source,
    cryptifyUrl: cryptifyUrl.value,
    cryptifyUrlSource: cryptifyUrl.source,
    apiKey: env.PG_API_KEY || '',
    citizen: env.PG_CITIZEN_EMAIL || 'citizen@example.com',
    org: env.PG_ORGANISATION_EMAIL || 'noreply@example.org',
    // The attribute types the SDK addresses recipients with. Empty means the
    // SDK's own production defaults; the candidate stack issues irma-demo
    // credentials and needs the demo type (postguard#236).
    emailAttribute: emailAttribute.value,
    jsVersions: jsVersions.value,
    jsVersionsSource: specSource(jsVersions.source, 'PG_JS_VERSIONS', p),
    dotnetVersions: dotnetVersions.value,
    dotnetVersionsSource: specSource(dotnetVersions.source, 'PG_DOTNET_VERSIONS', p),
    decryptSet: env.PG_DECRYPT_SET || '',
  };
}

/** True when we have enough to actually run the encrypt/upload flow. */
export function canRunFlow(config) {
  return Boolean(config.apiKey);
}
