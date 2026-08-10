import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';

const here = dirname(fileURLToPath(import.meta.url));

// See js/adapters/index.mjs for the adapter concept. Each entry supplies one
// program per leg, targeting a given range of E4A.PostGuard versions. The
// `decrypt` leg is a probe rather than a flow, because this SDK has no reader —
// see modern/DecryptProbe.cs for why asserting that beats skipping it.
const ADAPTERS = [
  {
    name: 'modern',
    range: '>=0.1.0',
    legs: {
      wire: join(here, 'modern', 'Program.cs'),
      decrypt: join(here, 'modern', 'DecryptProbe.cs'),
    },
  },
];

export function pickDotnetAdapter(version) {
  return (
    ADAPTERS.find((a) => semver.satisfies(version, a.range, { includePrerelease: true })) ?? null
  );
}
