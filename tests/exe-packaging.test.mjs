import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

function collectRelativeModuleGraph(entry) {
  const visited = new Set();
  const visit = relative => {
    if (visited.has(relative)) return;
    visited.add(relative);
    const source = read(relative);
    const specifiers = [
      ...[...source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]),
      ...[...source.matchAll(/\bimport\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]),
    ];
    for (const specifier of specifiers) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  };
  visit(entry);
  return [...visited].sort();
}

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
  for (const file of ['browser-callback-broker', 'companion-auth', 'hub-provider-adapters', 'hub-service', 'hub-page', 'hub-server', 'keyed-backoff', 'page-action-channel', 'process-lifecycle', 'secure-files', 'usage-normalization']) {
    assert.match(build, new RegExp(`'src\\\\${file}\\.mjs'`));
    assert.match(install, new RegExp(`'src\\\\${file}\\.mjs'`));
  }
  for (const file of ['manifest.json', 'background.js', 'session-state.js', 'anyrouter-waf.js', 'protocol.js', 'auth.js', 'popup.html', 'popup.js', 'README.md']) {
    const escaped = file.replaceAll('.', '\\.');
    assert.match(build, new RegExp(`'browser-companion\\\\${escaped}'`));
    assert.match(install, new RegExp(`'browser-companion\\\\${escaped}'`));
  }
  assert.doesNotMatch(build, /'src\\(?:cdp-disconnect-guard|target-discovery)\.mjs'/);
  assert.doesNotMatch(install, /'src\\(?:cdp-disconnect-guard|target-discovery)\.mjs'/);
  assert.match(build, /nodeProbe\.arch -ne 'x64'/);
  assert.match(build, /nodeProbe\.version -ne \$expectedNodeVersion/);
  assert.match(build, /payload-manifest\.sha256/);
  assert.match(build, /PayloadManifestSha256/);
  assert.match(build, /CODEXCCSWITCH_SIGNING_THUMBPRINT/);
  assert.match(build, /AllowUnsigned/);
  assert.match(build, /Invoke-CodeSign \$launcherTarget/);
  assert.match(build, /\/DSignedBuild=1/);
  assert.match(build, /signtool\.exe/);
  assert.match(build, /Framework64\\v4\.0\.30319\\csc\.exe/);
  assert.match(build, /\/platform:x64/);
  assert.doesNotMatch(build, /\/platform:anycpu/);
  assert.match(build, /LauncherVersion\.cs/);
  assert.match(build, /AssemblyFileVersion/);
  assert.match(build, /AssemblyInformationalVersion/);
  assert.doesNotMatch(read('packaging/launcher/Program.cs'), /AssemblyFileVersion\("1\.0\.0\.0"\)/);
  assert.match(build, /ISCC\.exe/);
  assert.match(build, /CodexCCSwitchUsage-Setup-\$version\.exe/);
  const launcher = read('packaging/launcher/Program.cs');
  assert.match(launcher, /VerifyPayloadManifest/);
  assert.match(launcher, /FixedHexEquals/);
  assert.match(launcher, /Package integrity verification failed/);
  const setup = read('packaging/setup.iss');
  assert.match(setup, /SignedUninstaller=yes/);
  assert.match(setup, /scripts\\stop\.ps1/);
  assert.doesNotMatch(build, /'scripts\\(?:install|stop|status|uninstall)\.ps1'/);
});

test('every transitive browser companion module is included in each packaging manifest', () => {
  const build = read('scripts/build-exe.ps1');
  const install = read('scripts/install.ps1');
  const modules = [...new Set([
    ...collectRelativeModuleGraph('browser-companion/background.js'),
    ...collectRelativeModuleGraph('browser-companion/popup.js'),
  ])].sort();

  for (const module of modules) {
    const packagedPath = module.replaceAll('/', '\\');
    assert.equal(build.includes(`'${packagedPath}'`), true, `${module} is missing from the EXE payload`);
    assert.equal(install.includes(`'${packagedPath}'`), true, `${module} is missing from the source installer payload`);
  }
});

test('GitHub releases always package and explain the browser companion', () => {
  const packageJson = JSON.parse(read('package.json'));
  const publish = read('scripts/publish-release.ps1');
  const template = read('docs/RELEASE_NOTES_TEMPLATE.md');
  const companionSection = read('docs/RELEASE_BROWSER_COMPANION_SECTION.md');
  const signedTrust = read('docs/RELEASE_TRUST_SIGNED.md');
  const unsignedTrust = read('docs/RELEASE_TRUST_UNSIGNED.md');
  const unsignedMac = read('docs/RELEASE_MACOS_UNSIGNED.md');
  const development = read('DEVELOPMENT.md');
  const userGuide = read('docs/V3.md');

  assert.equal(packageJson.scripts['release:github'].includes('scripts/publish-release.ps1'), true);
  assert.match(publish, /Compress-Archive/);
  assert.match(publish, /--pack-extension-key=/);
  assert.match(publish, /CreateSigningKey/);
  assert.match(publish, /\[switch\]\$AllowUnsigned/);
  assert.match(publish, /Get-AuthenticodeSignature/);
  assert.match(publish, /if \(-not \$AllowUnsigned -and \[string\]\$installerSignature\.Status -ne 'Valid'\)/);
  assert.match(publish, /Assert-NotarizedMacPackage/);
  assert.match(publish, /\$macPackageExtension = if \(\$AllowUnsigned\) \{ 'tar\.gz' \} else \{ 'zip' \}/);
  assert.match(publish, /if \(-not \$AllowUnsigned\) \{[\s\S]*Assert-NotarizedMacPackage/);
  assert.match(publish, /\$releaseTitle = if \(\$AllowUnsigned\)/);
  assert.match(publish, /unsigned = \[bool\]\$AllowUnsigned/);
  assert.match(publish, /Release template contains an unresolved placeholder/);
  assert.match(publish, /CRX3/);
  assert.match(publish, /Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(publish, /Get-FileHash/);
  assert.match(publish, /ReadAllText\(\$notesPath, \$utf8\)/);
  assert.match(publish, /UTF-8 round-trip validation failed/);
  assert.match(publish, /WriteAllText\(\$renderedNotes/);
  assert.match(publish, /GitHub Release is missing required assets/);
  assert.match(publish, /GitHub Release asset digest does not match local file/);
  assert.match(publish, /required browser companion instructions/);
  assert.doesNotMatch(publish, /[^\x00-\x7F]/);
  assert.match(publish, /RELEASE_BROWSER_COMPANION_SECTION/);
  assert.match(companionSection, /浏览器伴侣/);
  assert.match(companionSection, /browser-companion-required:start/);
  assert.match(companionSection, /\{\{RELEASE_TRUST_NOTICE\}\}/);
  assert.match(companionSection, /\{\{MACOS_ARM64_FILENAME\}\}/);
  assert.match(companionSection, /\{\{MACOS_X64_FILENAME\}\}/);
  assert.match(companionSection, /\{\{MACOS_PACKAGE_STATUS\}\}/);
  assert.match(signedTrust, /Authenticode/);
  assert.match(unsignedTrust, /未签名/);
  assert.match(unsignedTrust, /CODEXCCSWITCH_SIGNING_THUMBPRINT/);
  assert.match(unsignedTrust, /普通用户不需要配置/);
  assert.match(unsignedMac, /Gatekeeper/);
  assert.match(template, /scripts\/publish-release\.ps1/);
  assert.match(development, /release:github/);
  assert.match(userGuide, /CCSwitch-Browser-Companion/);
});

test('macOS release packages include both native architectures and writable app-bundle paths', () => {
  const packageJson = JSON.parse(read('package.json'));
  const build = read('scripts/build-macos-package.ps1');
  const archive = read('scripts/create-macos-archive.mjs');
  const launcher = read('packaging/macos/CodexCCSwitchUsage');
  const stopHost = read('packaging/macos/stop-host.command');
  const plist = read('packaging/macos/Info.plist');
  const publish = read('scripts/publish-release.ps1');

  assert.equal(packageJson.scripts['build:macos'].includes('scripts/build-macos-package.ps1'), true);
  assert.match(build, /darwin-arm64/);
  assert.match(build, /darwin-x64/);
  assert.match(build, /runtime-bin/);
  assert.match(build, /create-macos-archive\.mjs/);
  assert.match(build, /CodeSignIdentity/);
  assert.match(build, /notarytool submit/);
  assert.match(build, /stapler staple/);
  assert.match(build, /ditto -c -k --sequesterRsrc --keepParent/);
  assert.match(build, /AllowUnsigned/);
  assert.match(build, /notarized\.json/);
  assert.match(archive, /prefix = path\.basename/);
  assert.match(archive, /0o755/);
  assert.match(launcher, /--runtime-dir/);
  assert.match(launcher, /Library\/Application Support\/CodexCCSwitchUsage/);
  assert.match(stopHost, /--all-instances/);
  assert.match(plist, /@VERSION@/);
  assert.match(plist, /@ARCH@/);
  assert.match(publish, /CodexCCSwitchUsage-macos-arm64-\$version\.\$macPackageExtension/);
  assert.match(publish, /CodexCCSwitchUsage-macos-x64-\$version\.\$macPackageExtension/);
  assert.match(publish, /'tar\.gz'/);
  assert.match(publish, /MACOS_ARM64_SHA256/);
  assert.match(publish, /MACOS_X64_SHA256/);
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
