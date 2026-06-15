import { mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
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
 * and run the matching flow. Returns the same result shape as runJsVersion.
 * `install` covers restore+build; a compile failure against an old API shows
 * up here (a real signal, distinct from a runtime/server break).
 */
export async function runDotnetVersion(version, config) {
  const result = {
    client: 'dotnet',
    version,
    install: 'n/a',
    run: 'n/a',
    error: null,
    sentClientVersion: null,
  };

  const adapter = pickDotnetAdapter(version);
  if (!adapter) {
    result.run = 'no_adapter';
    result.error = `no adapter matches ${version}`;
    return result;
  }

  const dir = join(sandboxRoot, version);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'probe.csproj'), csproj(version));
    writeFileSync(join(dir, 'Program.cs'), readFileSync(adapter.programFile, 'utf8'));
  } catch (e) {
    result.install = 'fail';
    result.error = `sandbox setup: ${e.message}`;
    return result;
  }

  // `dotnet build` covers restore + compile.
  const build = await run('dotnet', ['build', '-c', 'Release', '--nologo', '-v', 'quiet'], {
    cwd: dir,
  });
  if (build.code !== 0) {
    result.install = 'fail';
    result.error = trimErr(build.stdout || build.stderr);
    return result;
  }
  result.install = 'ok';

  if (!canRunFlow(config)) {
    result.run = 'skipped_no_api_key';
    return result;
  }

  const out = await run(
    'dotnet',
    ['run', '-c', 'Release', '--no-build', '--nologo'],
    { cwd: dir, env: envForFlow(config) }
  );
  const parsed = parseResult(out.stdout);
  if (out.code === 0 && parsed?.ok) {
    result.run = 'pass';
  } else {
    result.run = 'fail';
    result.error = parsed?.error || trimErr(out.stderr || out.stdout) || `exit ${out.code}`;
  }
  return result;
}
