// Is this module the process entry point? Every runnable script under `src/`
// asks through here.
//
// The idiom this replaces — `import.meta.url === `file://${process.argv[1]}`` —
// is wrong twice. It does not percent-encode the path, and it compares a
// symlink-resolved path against an unresolved URL: Node resolves the entry it
// loads through symlinks, `import.meta.url` keeps the specifier it was imported
// with. On macOS every `os.tmpdir()` path is a symlink (`/var/folders/…` ->
// `/private/var/folders/…`), so a script run from a temp directory decides it
// is NOT main, executes nothing, and exits 0 — a runner that silently does
// nothing, which is exactly what a test that spawns one cannot see.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module identified by `metaUrl` is what node was asked to run.
 *
 * @param {string} metaUrl the caller's `import.meta.url`
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    // Either path can be gone or unreadable (a deleted temp dir, a bundled
    // entry that is not a file). Not main, rather than a crash on startup.
    return false;
  }
}
