import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import semver from 'semver';

const here = dirname(fileURLToPath(import.meta.url));

// See js/adapters/index.mjs for the adapter concept. Each entry supplies a
// Program.cs flow that targets a given range of E4A.PostGuard versions.
const ADAPTERS = [
  { name: 'modern', range: '>=0.1.0', programFile: join(here, 'modern', 'Program.cs') },
];

export function pickDotnetAdapter(version) {
  return (
    ADAPTERS.find((a) => semver.satisfies(version, a.range, { includePrerelease: true })) ?? null
  );
}
