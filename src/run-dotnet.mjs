import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickDotnetAdapter } from './dotnet/adapters/index.mjs';
import { canRunFlow } from './config.mjs';
import { run, parseResult, trimErr, envForFlow } from './spawn.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxRoot = join(repoRoot, '.sandbox', 'dotnet');

// Consumer TFM for the sandbox project. net8.0 keeps the broadest
// compatibility with older E4A.PostGuard releases; running it requires the
// .NET 8 runtime to be installed on the host.
const TARGET_FRAMEWORK = 'net8.0';

function csproj(version) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${TARGET_FRAMEWORK}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="E4A.PostGuard" Version="${version}" />
  </ItemGroup>
</Project>
`;
}

/**
 * Restore one published E4A.PostGuard version in an isolated sandbox project
 * per leg and run them. Returns the same result shape as runJsVersion.
 * `install` covers restore+build of the first leg's project; a compile failure
 * against an old API shows up there (a real signal, distinct from a
 * runtime/server break).
 *
 * One project per leg rather than one project with two entry points: the legs
 * are separate programs, and a leg that fails to compile must not take the
 * other leg's verdict with it.
 */
export async function runDotnetVersion(version, config, { legs = ['wire'] } = {}) {
  const result = {
    client: 'dotnet',
    version,
    install: 'n/a',
    error: null,
    legs: {},
  };

  const adapter = pickDotnetAdapter(version);
  if (!adapter) {
    result.error = `no adapter matches ${version}`;
    for (const leg of legs) result.legs[leg] = { outcome: 'no_leg', error: result.error };
    return result;
  }

  for (const leg of legs) {
    if (!adapter.legs[leg]) {
      result.legs[leg] = { outcome: 'no_leg', error: `adapter ${adapter.name} has no ${leg} leg` };
      continue;
    }

    const dir = join(sandboxRoot, `${version}-${leg}`);
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'probe.csproj'), csproj(version));
      writeFileSync(join(dir, 'Program.cs'), readFileSync(adapter.legs[leg], 'utf8'));
    } catch (e) {
      result.install = 'fail';
      result.error = `sandbox setup: ${e.message}`;
      result.legs[leg] = { outcome: 'skipped_install_failed', error: result.error };
      continue;
    }

    // `dotnet build` covers restore + compile.
    const build = await run('dotnet', ['build', '-c', 'Release', '--nologo', '-v', 'quiet'], {
      cwd: dir,
    });
    if (build.code !== 0) {
      result.install = 'fail';
      result.error = trimErr(build.stdout || build.stderr);
      result.legs[leg] = { outcome: 'skipped_install_failed', error: result.error };
      continue;
    }
    // Only claim the install is ok while no leg has failed to build: the field
    // is per version, and one green build must not overwrite another's failure.
    if (result.install !== 'fail') result.install = 'ok';

    result.legs[leg] = leg === 'wire' ? await wireLeg(dir, config) : await decryptLeg(dir);
  }

  return result;
}

/** params -> encrypt (API-key signing) -> upload, via the published SDK. */
async function wireLeg(dir, config) {
  if (!canRunFlow(config)) {
    return { outcome: 'skipped_no_api_key', error: null, sentClientVersion: null };
  }
  const out = await run('dotnet', ['run', '-c', 'Release', '--no-build', '--nologo'], {
    cwd: dir,
    env: envForFlow(config),
  });
  const parsed = parseResult(out.stdout);
  if (out.code === 0 && parsed?.ok) return { outcome: 'pass', error: null };
  return {
    outcome: 'fail',
    error: parsed?.error || trimErr(out.stderr || out.stdout) || `exit ${out.code}`,
  };
}

/**
 * The .NET SDK has no reader, so its decrypt leg asserts that rather than
 * skipping it (see modern/DecryptProbe.cs). A pass here means "still no decrypt
 * API, as recorded"; the leg goes red the day one appears.
 */
async function decryptLeg(dir) {
  const out = await run('dotnet', ['run', '-c', 'Release', '--no-build', '--nologo'], { cwd: dir });
  const parsed = parseResult(out.stdout);
  if (out.code === 0 && parsed?.ok) {
    return { outcome: 'documented_refusal', error: null, note: parsed.documentedRefusal };
  }
  return {
    outcome: 'fail',
    error: parsed?.error || trimErr(out.stderr || out.stdout) || `exit ${out.code}`,
  };
}
