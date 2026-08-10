import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';

const here = dirname(fileURLToPath(import.meta.url));

// Adapters map a semver range to the flow scripts that are copied into each
// version's sandbox and run there (so `@e4a/pg-js` resolves to the installed
// version). As the public API drifts across majors, add a new set of flow files
// and register it here, MOST-SPECIFIC range first.
//
// One script per leg, because the legs ask different questions of different
// systems: `wire` drives the non-interactive server-facing path against the
// target deployment, `decrypt` opens an artifact the new stack sealed and needs
// no server at all. An adapter that cannot answer a leg omits it, and the runner
// records that absence rather than passing over it.
const ADAPTERS = [
  {
    name: 'modern',
    range: '>=1.0.0',
    legs: {
      wire: join(here, 'modern.mjs'),
      decrypt: join(here, 'modern-open.mjs'),
    },
  },
];

export function pickJsAdapter(version) {
  return (
    ADAPTERS.find((a) => semver.satisfies(version, a.range, { includePrerelease: true })) ?? null
  );
}
