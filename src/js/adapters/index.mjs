import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';

const here = dirname(fileURLToPath(import.meta.url));

// Adapters map a semver range to a flow script that is copied into each
// version's sandbox and run there (so `@e4a/pg-js` resolves to the installed
// version). As the public API drifts across majors, add a new flow file and
// register it here, MOST-SPECIFIC range first.
const ADAPTERS = [
  { name: 'modern', range: '>=1.0.0', flowFile: join(here, 'modern.mjs') },
];

export function pickJsAdapter(version) {
  return (
    ADAPTERS.find((a) => semver.satisfies(version, a.range, { includePrerelease: true })) ?? null
  );
}
