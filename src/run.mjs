import { loadConfig } from './config.mjs';
import { enumerateJs, enumerateDotnet } from './enumerate.mjs';
import { filterVersions } from './filter.mjs';
import { runJsVersion } from './run-js.mjs';
import { runDotnetVersion } from './run-dotnet.mjs';
import { commandExists } from './spawn.mjs';
import { writeReport } from './report.mjs';

const which = (process.argv[2] || 'all').toLowerCase();
const config = loadConfig();

function summary(r) {
  const sent = r.sentClientVersion ? ` sent=${r.sentClientVersion}` : '';
  const err = r.error ? ` (${r.error})` : '';
  return `install=${r.install} run=${r.run}${sent}${err}`;
}

console.log('PostGuard version-matrix');
console.log(`  PKG:      ${config.pkgUrl}`);
console.log(`  Cryptify: ${config.cryptifyUrl}`);
console.log(
  `  API key:  ${config.apiKey ? 'set' : 'NOT set → flow runs skipped (install/compile only)'}`
);
console.log('');

const results = { js: [], dotnet: [] };

if (which === 'js' || which === 'all') {
  try {
    const all = enumerateJs();
    const versions = filterVersions(all, config.jsVersions);
    console.log(
      `@e4a/pg-js: sweeping ${versions.length} of ${all.length} published [filter: ${config.jsVersions}]`
    );
    for (const v of versions) {
      process.stdout.write(`  ${v} … `);
      const r = await runJsVersion(v, config);
      results.js.push(r);
      console.log(summary(r));
    }
  } catch (e) {
    console.error(`  @e4a/pg-js sweep failed: ${e.message}`);
  }
  console.log('');
}

if (which === 'dotnet' || which === 'all') {
  if (!(await commandExists('dotnet'))) {
    console.log('E4A.PostGuard: dotnet SDK not found → skipping .NET sweep.');
  } else {
    try {
      const all = await enumerateDotnet();
      const versions = filterVersions(all, config.dotnetVersions);
      console.log(
        `E4A.PostGuard: sweeping ${versions.length} of ${all.length} published [filter: ${config.dotnetVersions}]`
      );
      for (const v of versions) {
        process.stdout.write(`  ${v} … `);
        const r = await runDotnetVersion(v, config);
        results.dotnet.push(r);
        console.log(summary(r));
      }
    } catch (e) {
      console.error(`  E4A.PostGuard sweep failed: ${e.message}`);
    }
  }
  console.log('');
}

const paths = writeReport(results, config);
console.log(`Report written:\n  ${paths.md}\n  ${paths.csv}`);
