// The sweep: enumerate published versions, resolve the support matrix, install
// each version in a sandbox and run every requested leg against it.
//
//   node src/run.mjs [all|js|dotnet] [--profile nightly|pre-deploy] [--legs wire,decrypt]
//
// Exits nonzero only when the HARNESS could not do its job — a registry that
// would not answer, a matrix that resolved to nothing, an artifact that would
// not seal. A version that failed a leg is a finding, and the verdict on
// findings belongs to `gate.mjs`, one gate per leg: the sweep is expensive and
// answers several questions at once, so it always gets as far as writing the
// report.

import { appendFileSync } from 'node:fs';

import { loadConfig } from './config.mjs';
import { enumerateJs, enumerateDotnet } from './enumerate.mjs';
import { filterVersions } from './filter.mjs';
import { pickUniverse, startPkgStub } from './keys.mjs';
import {
  clientsFor,
  coverageScope,
  missingRequiredLegs,
  resolveClient,
  resolveLegs,
} from './matrix.mjs';
import { writeReport } from './report.mjs';
import { runDotnetVersion } from './run-dotnet.mjs';
import { runJsVersion } from './run-js.mjs';
import { sealWithNewStack } from './seal.mjs';
import { commandExists } from './spawn.mjs';
import { notSweptClients } from './verdict.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' || argv[i] === '--legs') {
      flags[argv[i].slice(2)] = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { which: positional[0], ...flags };
}

const args = parseArgs(process.argv.slice(2));
let which;
let legs;
let config;
try {
  // A typo in any of the three sweeps something other than what was asked for,
  // so all three refuse rather than fall back. Same reporting as gate.mjs: the
  // message is the useful part, a stack trace through resolveClient is not.
  which = resolveClient(args.which);
  legs = resolveLegs(args.legs);
  config = loadConfig({ profile: args.profile ?? null });
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}

// A profile declares which legs it holds mandatory, and a sweep that runs fewer
// than that covers less than the profile promises.
const missing = missingRequiredLegs(config.requires, legs);
if (missing.length > 0) {
  console.error(
    `The ${config.profile} profile holds ${config.requires.join(', ')} mandatory, so it cannot ` +
      `be swept without ${missing.join(', ')}.`
  );
  process.exit(1);
}

function summary(row) {
  const parts = legs.map((leg) => `${leg}=${row.legs?.[leg]?.outcome ?? 'n/a'}`);
  const sent = row.legs?.wire?.sentClientVersion;
  const error = row.error || legs.map((leg) => row.legs?.[leg]?.error).find(Boolean);
  return (
    `install=${row.install} ${parts.join(' ')}` +
    (sent ? ` sent=${sent}` : '') +
    (error ? ` (${error})` : '')
  );
}

console.log('PostGuard version-matrix');
console.log(`  Profile:  ${config.profile ?? 'none (manual sweep)'}`);
console.log(`  Legs:     ${legs.join(', ')}`);
console.log(`  PKG:      ${config.pkgUrl} [${config.pkgUrlSource}]`);
console.log(`  Cryptify: ${config.cryptifyUrl} [${config.cryptifyUrlSource}]`);
console.log(
  `  API key:  ${config.apiKey ? 'set' : 'NOT set → wire legs skipped (install/compile only)'}`
);
if (config.emailAttribute) console.log(`  Email attribute: ${config.emailAttribute}`);

// The decrypt legs open ONE artifact, sealed once before the sweep starts. It is
// the same bytes for every version on purpose: "this version cannot open what
// that version can" is only a statement about the versions if the container is
// identical.
//
// Only the pg-js decrypt leg opens it. The .NET decrypt leg is a reflection
// probe over an SDK that has no reader at all, so a `dotnet`-only sweep needs no
// artifact — and sealing one there would spend an install on nothing and let a
// registry hiccup on @e4a/pg-wasm abort a run whose legs never needed it.
let decrypt = null;
if (legs.includes('decrypt') && which !== 'dotnet') {
  let universe;
  let sealed;
  let stub;
  try {
    universe = pickUniverse(config.decryptSet);
    sealed = await sealWithNewStack(universe);
    stub = await startPkgStub(universe);
  } catch (e) {
    // No artifact means no decrypt leg can run at all, so there is nothing to
    // report and nothing for a gate to judge. Say why and stop here rather than
    // sweeping on and writing a report whose decrypt column is empty for a
    // reason no reader could recover.
    console.error(`\nThe decrypt legs have no artifact to open: ${e.message}`);
    process.exit(1);
  }
  decrypt = {
    pkgUrl: stub.url,
    container: sealed.container,
    recipientId: universe.recipientId,
    senderEmail: universe.senderEmail,
    sealedBy: `@e4a/pg-wasm@${sealed.version}`,
    universe: universe.name,
    sealerVersion: sealed.version,
    stub,
  };
  console.log(
    `  Decrypt:  ${sealed.bytes} bytes sealed by @e4a/pg-wasm@${sealed.version} into ` +
      `${universe.name} (sealed by ${universe.sealedBy}), recipient ${universe.recipientId}`
  );
}
console.log('');

const results = { js: [], dotnet: [] };
const harnessErrors = [];
// Why a client contributed no rows, when the sweep knows. Read by
// notSweptClients below, and from there by both gates.
const notSweptWhy = {};

if (which === 'js' || which === 'all') {
  try {
    const all = enumerateJs();
    const versions = filterVersions(all, config.jsVersions);
    console.log(
      `@e4a/pg-js: sweeping ${versions.length} of ${all.length} published ` +
        `[filter: ${config.jsVersions} — ${config.jsVersionsSource}]`
    );
    if (versions.length === 0) {
      harnessErrors.push(`@e4a/pg-js filter "${config.jsVersions}" resolved to no version`);
    }
    for (const v of versions) {
      process.stdout.write(`  ${v} … `);
      const r = await runJsVersion(v, config, { legs, decrypt });
      results.js.push(r);
      console.log(summary(r));
    }
  } catch (e) {
    console.error(`  @e4a/pg-js sweep failed: ${e.message}`);
    harnessErrors.push(`@e4a/pg-js sweep failed: ${e.message}`);
  }
  console.log('');
}

if (which === 'dotnet' || which === 'all') {
  if (!(await commandExists('dotnet'))) {
    console.log('E4A.PostGuard: dotnet SDK not found → skipping .NET sweep.');
    notSweptWhy.dotnet = 'no dotnet SDK on the machine that ran the sweep';
  } else {
    try {
      const all = await enumerateDotnet();
      const versions = filterVersions(all, config.dotnetVersions);
      console.log(
        `E4A.PostGuard: sweeping ${versions.length} of ${all.length} published ` +
          `[filter: ${config.dotnetVersions} — ${config.dotnetVersionsSource}]`
      );
      if (versions.length === 0) {
        harnessErrors.push(
          `E4A.PostGuard filter "${config.dotnetVersions}" resolved to no version`
        );
      }
      for (const v of versions) {
        process.stdout.write(`  ${v} … `);
        const r = await runDotnetVersion(v, config, { legs });
        results.dotnet.push(r);
        console.log(summary(r));
      }
    } catch (e) {
      console.error(`  E4A.PostGuard sweep failed: ${e.message}`);
      harnessErrors.push(`E4A.PostGuard sweep failed: ${e.message}`);
    }
  }
  console.log('');
}

if (decrypt) {
  console.log(`Decrypt legs asked the PKG stub for: ${decrypt.stub.asked().join(', ') || 'nothing'}`);
  await decrypt.stub.close();
}

// A client that was in scope and produced nothing is coverage loss the gates
// cannot see for themselves, so it travels in the report. The scope is the
// profile's, not the positional's (see coverageScope): a client left out of
// `sweep --profile nightly js` is a support window this run claimed and did not
// touch, so it has to reach the gates the same way a missing .NET SDK does.
//
// On a developer machine a missing SDK is not a harness error; under a profile it
// is, because the profile is a claim about a support window the sweep then did
// not touch.
const swept = clientsFor(which);
const scope = coverageScope(which, config.profile);
for (const client of scope) {
  if (!swept.includes(client)) notSweptWhy[client] = `the sweep was asked for ${which} only`;
}
const notSwept = notSweptClients(scope, results, notSweptWhy);
if (config.profile) {
  for (const { client, why } of notSwept) {
    harnessErrors.push(
      `${client} was not swept at all (${why}), so the ${config.profile} profile covered ` +
        'none of its support window'
    );
  }
}

const paths = writeReport(results, config, {
  profile: config.profile,
  target: config.target,
  legs,
  notSwept,
  decrypt: decrypt
    ? {
        universe: decrypt.universe,
        sealerVersion: decrypt.sealerVersion,
        recipientId: decrypt.recipientId,
      }
    : null,
});
console.log(`Report written:\n  ${paths.md}\n  ${paths.csv}\n  ${paths.json}`);

// The job summary is where a nightly is actually read. Appending the report
// itself keeps the verdict and the evidence in one place.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, paths.markdown + '\n');
}

if (harnessErrors.length > 0) {
  console.error('\nThe sweep could not do its job:');
  for (const error of harnessErrors) console.error(`  ${error}`);
  console.error('The report above covers only what did run; the gates read it as it stands.');
  process.exitCode = 1;
}
