import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('EXE launcher preserves the PowerShell flow and starts the host detached', () => {
  const source = read('packaging/launcher/Program.cs');

  assert.match(source, /Path\.Combine\(root, "scripts", "launch\.ps1"\)/);
  assert.match(source, /Path\.Combine\(root, "runtime-bin"\)/);
  assert.match(source, /"-InstallRoot", root/);
  assert.doesNotMatch(source, /EnvironmentVariables\["PATH"\]/);
  assert.match(source, /BuildArguments/);
  assert.match(source, /QuoteArgument/);
  assert.match(source, /BeginOutputReadLine\(\)/);
  assert.match(source, /BeginErrorReadLine\(\)/);
  assert.match(source, /while \(!process\.WaitForExit\(1000\)\)/);
  assert.doesNotMatch(source, /process\.WaitForExit\(\);/);
  assert.match(source, /outputClosed\.WaitOne\(1500\)/);
  assert.match(source, /errorClosed\.WaitOne\(1500\)/);
  assert.match(source, /"--start-host"/);
  assert.match(source, /string node = Path\.Combine\(root, "runtime-bin", "node\.exe"\);/);
  assert.match(source, /DETACHED_PROCESS/);
  assert.match(source, /CreateProcessW/);
  assert.match(source, /CreateProcessW\(\s*node,/);
  assert.match(source, /false,\s*DETACHED_PROCESS/);
  assert.match(source, /GetArgumentValue\(args, "--codex-pid", "0"\)/);
  assert.match(source, /"--codex-pid", codexPid\.ToString\(\)/);
  assert.match(source, /require\('node:sqlite'\)/);
  assert.match(source, /process\.arch!=='x64'/);
});

test('installer upgrades only stop the plugin host and preserve runtime data', () => {
  const setup = read('packaging/setup.iss');
  const stopHost = read('scripts/stop-host.ps1');

  assert.match(setup, /PrivilegesRequired=lowest/);
  assert.match(setup, /#define AppId "\{\{E20F73F0-A63F-4B72-BF42-CC0C949BB27D\}"/);
  assert.match(setup, /AppId=\{#AppId\}/);
  assert.match(setup, /DefaultDirName=\{#DefaultInstallDir\}/);
  assert.match(setup, /stop-host\.ps1/);
  assert.match(setup, /Name: "\{app\}\\runtime"/);
  assert.match(setup, /Name: "\{userprograms\}\\Codex \+ CCSwitch 用量"; Filename: "\{app\}\\CodexCCSwitchUsage\.exe"; WorkingDir: "\{app\}"/);
  assert.match(setup, /Source: "\{#PackageRoot\}\\\*"; Excludes: "runtime-bin\\node\.exe"/);
  assert.match(setup, /Source: "\{#PackageRoot\}\\runtime-bin\\node\.exe"; DestDir: "\{app\}\\runtime-bin"\s*$/m);
  assert.doesNotMatch(setup, /Name: "startmenuicon"/);
  assert.doesNotMatch(setup, /\{userprograms\}\\Codex \+ CCSwitch 用量[^\r\n]*Tasks:/);
  assert.match(setup, /postinstall skipifsilent/);
  assert.match(setup, /\{param:nostopall\|0\}/);
  assert.doesNotMatch(stopHost, /ChatGPT\.exe/);
  assert.doesNotMatch(stopHost, /scripts\\stop\.ps1/);
  assert.match(stopHost, /src\\host\.mjs/);
  assert.match(stopHost, /\[switch\]\$AllInstances/);
  assert.match(stopHost, /package\.name -ne 'codex-ccswitch-usage'/);
});

test('repeatable EXE build embeds the current Node runtime and emits a versioned installer', () => {
  const packageJson = JSON.parse(read('package.json'));
  const build = read('scripts/build-exe.ps1');
  const install = read('scripts/install.ps1');

  assert.equal(packageJson.scripts['build:exe'].includes('scripts/build-exe.ps1'), true);
  assert.match(build, /runtime-bin\\node\.exe/);
  for (const file of ['browser-callback-broker', 'hub-provider-adapters', 'hub-service', 'hub-page', 'hub-server', 'keyed-backoff', 'page-action-channel', 'process-lifecycle']) {
    assert.match(build, new RegExp(`'src\\\\${file}\\.mjs'`));
    assert.match(install, new RegExp(`'src\\\\${file}\\.mjs'`));
  }
  for (const file of ['manifest.json', 'background.js', 'session-state.js', 'popup.html', 'popup.js', 'README.md']) {
    const escaped = file.replaceAll('.', '\\.');
    assert.match(build, new RegExp(`'browser-companion\\\\${escaped}'`));
    assert.match(install, new RegExp(`'browser-companion\\\\${escaped}'`));
  }
  assert.doesNotMatch(build, /'src\\(?:cdp-disconnect-guard|target-discovery)\.mjs'/);
  assert.doesNotMatch(install, /'src\\(?:cdp-disconnect-guard|target-discovery)\.mjs'/);
  assert.match(build, /nodeProbe\.arch -ne 'x64'/);
  assert.match(build, /nodeProbe\.major -lt 22/);
  assert.match(build, /Framework64\\v4\.0\.30319\\csc\.exe/);
  assert.match(build, /\/platform:x64/);
  assert.doesNotMatch(build, /\/platform:anycpu/);
  assert.match(build, /LauncherVersion\.cs/);
  assert.match(build, /AssemblyFileVersion/);
  assert.match(build, /AssemblyInformationalVersion/);
  assert.doesNotMatch(read('packaging/launcher/Program.cs'), /AssemblyFileVersion\("1\.0\.0\.0"\)/);
  assert.match(build, /ISCC\.exe/);
  assert.match(build, /CodexCCSwitchUsage-Setup-\$version\.exe/);
});

test('one-time profile migration is not shipped', () => {
  const build = read('scripts/build-exe.ps1');
  const install = read('scripts/install.ps1');
  const setup = read('packaging/setup.iss');

  assert.equal(fs.existsSync(new URL('../scripts/migrate-default-profile.ps1', import.meta.url)), false);
  assert.doesNotMatch(build, /'scripts\\migrate-default-profile\.ps1'/);
  assert.match(install, /Remove-Item -LiteralPath \(Join-Path \$target 'scripts\\migrate-default-profile\.ps1'\)/);
  assert.match(setup, /\[InstallDelete\][\s\S]*scripts\\migrate-default-profile\.ps1/);
});
