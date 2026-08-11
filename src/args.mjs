// The sweep's command line.
//
// Its own module so the refusals below can be unit-tested: run.mjs sweeps at
// import time, so nothing declared inside it can be exercised without spawning a
// real sweep.

/** Flags that take the next argv entry as their value. */
const VALUE_FLAGS = ['--profile', '--legs'];

/**
 * Parses `[all|js|dotnet] [--profile NAME] [--legs a,b]`.
 *
 * A flag with no value refuses rather than falling back, which is what
 * `resolveClient`, `resolveProfile` and `resolveLegs` each already do with a typo.
 * Two cases it closes:
 *
 *   sweep -- --profile              profile was `undefined`, and `?? null` turned
 *                                   that into a MANUAL sweep — no `requires` to
 *                                   enforce and the staging default for a target,
 *                                   so the gates judged a run nobody asked for.
 *   sweep -- --profile --legs wire  profile was set to the string `--legs`.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!VALUE_FLAGS.includes(argv[i])) {
      positional.push(argv[i]);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(
        `${argv[i]} needs a value (got ${value === undefined ? 'nothing' : `"${value}"`})`
      );
    }
    flags[argv[i].slice(2)] = value;
    i++;
  }
  return { which: positional[0], ...flags };
}
