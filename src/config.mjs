// Reads run configuration from the environment (see config.example.env).

export function loadConfig() {
  return {
    pkgUrl: process.env.PG_PKG_URL || 'https://pkg.staging.postguard.eu',
    cryptifyUrl: process.env.PG_CRYPTIFY_URL || 'https://storage.staging.postguard.eu',
    apiKey: process.env.PG_API_KEY || '',
    citizen: process.env.PG_CITIZEN_EMAIL || 'citizen@example.com',
    org: process.env.PG_ORGANISATION_EMAIL || 'noreply@example.org',
    jsVersions: process.env.PG_JS_VERSIONS || 'latest:5',
    dotnetVersions: process.env.PG_DOTNET_VERSIONS || 'latest:5',
  };
}

/** True when we have enough to actually run the encrypt/upload flow. */
export function canRunFlow(config) {
  return Boolean(config.apiKey);
}
