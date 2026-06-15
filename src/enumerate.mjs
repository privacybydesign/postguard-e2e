import { execFileSync } from 'node:child_process';

/** All published versions of @e4a/pg-js (via the public npm registry). */
export function enumerateJs() {
  const out = execFileSync('npm', ['view', '@e4a/pg-js', 'versions', '--json'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** All published versions of E4A.PostGuard (via the NuGet flat-container API). */
export async function enumerateDotnet() {
  const url = 'https://api.nuget.org/v3-flatcontainer/e4a.postguard/index.json';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NuGet index returned HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.versions ?? [];
}

// Runnable directly: `node src/enumerate.mjs` prints both lists.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log('@e4a/pg-js (npm):');
    console.log('  ' + enumerateJs().join(', '));
  } catch (e) {
    console.error('  failed to enumerate npm versions:', e.message);
  }
  try {
    const dn = await enumerateDotnet();
    console.log('E4A.PostGuard (NuGet):');
    console.log('  ' + dn.join(', '));
  } catch (e) {
    console.error('  failed to enumerate NuGet versions:', e.message);
  }
}
