// The sweep's command line refuses the same way its three resolvers do: a flag
// that names no value is a mistake, not a default.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './args.mjs';

test('a full command line parses to the client, the profile and the legs', () => {
  assert.deepEqual(parseArgs(['js', '--profile', 'nightly', '--legs', 'wire,decrypt']), {
    which: 'js',
    profile: 'nightly',
    legs: 'wire,decrypt',
  });
  // Order is free, and no positional is the `all` default resolveClient applies.
  assert.deepEqual(parseArgs(['--legs', 'decrypt', 'dotnet']), {
    which: 'dotnet',
    legs: 'decrypt',
  });
  assert.deepEqual(parseArgs([]), { which: undefined });
});

test('a flag with no value refuses instead of turning into a manual sweep', () => {
  // `--profile` alone used to yield `undefined`, which `?? null` then read as "no
  // profile": no `requires` to enforce, the staging default for a target, and the
  // gates judging a run nobody asked for.
  assert.throws(() => parseArgs(['--profile']), /--profile needs a value \(got nothing\)/);
  assert.throws(() => parseArgs(['js', '--legs']), /--legs needs a value \(got nothing\)/);
});

test('a flag does not swallow the next flag as its value', () => {
  // This one set the profile to the string `--legs`, which resolveProfile then
  // reported as an unknown profile — loud, but about the wrong thing.
  assert.throws(
    () => parseArgs(['--profile', '--legs', 'wire']),
    /--profile needs a value \(got "--legs"\)/
  );
});
