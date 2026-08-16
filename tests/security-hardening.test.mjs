import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

test('runtime ACL hardening removes inherited access for other local users', {
  skip: process.platform !== 'win32',
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-private-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  const token = path.join(runtime, 'hub-token');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(token, 'test-token', 'utf8');

  const hardened = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'harden-acl.ps1'),
    '-InstallRoot', directory,
    '-RuntimeOnly',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(hardened.status, 0, hardened.stderr || hardened.stdout);

  const inspect = [
    `$acl=[IO.FileInfo]::new(${psLiteral(token)}).GetAccessControl()`,
    '$sids=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)',
    '$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
    '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; owner=$owner; current=$current; sids=$sids } | ConvertTo-Json -Compress',
  ].join('; ');
  const inspected = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-Command', inspect,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const acl = JSON.parse(inspected.stdout.trim());

  assert.equal(acl.protected, true);
  assert.equal(acl.owner, acl.current, 'the current user must own the protected token ACL');
  assert.ok(acl.sids.includes('S-1-5-18'), 'SYSTEM must retain access');
  assert.ok(acl.sids.includes('S-1-5-32-544'), 'Administrators must retain access');
  assert.equal(acl.sids.includes('S-1-5-11'), false, 'Authenticated Users must not retain access');
  assert.equal(acl.sids.includes('S-1-5-32-545'), false, 'the local Users group must not retain access');
  assert.equal(acl.sids.length, 3, 'only the current user, SYSTEM, and Administrators may access the token');
});

test('PowerShell Core migrates an owner-owned runtime that grants only inherited-style Modify access', {
  skip: process.platform !== 'win32',
}, t => {
  const probe = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSEdition'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.error?.code === 'ENOENT') {
    t.skip('PowerShell Core is not installed');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-private-runtime-pwsh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'hub-token'), 'test-token', 'utf8');
  const restricted = spawnSync('icacls.exe', [
    runtime,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-11:(OI)(CI)M',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(restricted.status, 0, restricted.stderr || restricted.stdout);
  const hardened = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'harden-acl.ps1'),
    '-InstallRoot', directory,
    '-RuntimeOnly',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(hardened.status, 0, hardened.stderr || hardened.stdout);
});

test('ACL hardening rejects a reparse-point install root', {
  skip: process.platform !== 'win32',
}, t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-reparse-root-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'target');
  const linkedRoot = path.join(parent, 'linked-root');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, linkedRoot, 'junction');
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const hardened = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'harden-acl.ps1'),
    '-InstallRoot', linkedRoot,
  ], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(hardened.status, 0);
  assert.match(`${hardened.stderr}\n${hardened.stdout}`, /reparse-point install root/i);
});

test('every launch and installation path ships and applies ACL hardening', () => {
  const launch = read(path.join('scripts', 'launch.ps1'));
  const install = read(path.join('scripts', 'install.ps1'));
  const build = read(path.join('scripts', 'build-exe.ps1'));
  const setup = read(path.join('packaging', 'setup.iss'));
  const harden = read(path.join('scripts', 'harden-acl.ps1'));

  assert.match(launch, /harden-acl\.ps1/);
  assert.match(launch, /-RuntimeOnly/);
  assert.match(harden, /ReparsePoint/);
  assert.match(install, /& \$aclScript -InstallRoot \$target/);
  assert.ok(install.indexOf('& $aclScript -InstallRoot $target') < install.indexOf('$files = @('));
  assert.match(install, /& \$stopHostScript -InstallRoot \$target -AllInstances/);
  const installPayload = install.slice(install.indexOf('$files = @('), install.indexOf('foreach ($relative in $files)'));
  assert.doesNotMatch(installPayload, /'scripts\\stop\.ps1'/);
  assert.match(install, /Remove-Item -LiteralPath \(Join-Path \$target 'scripts\\stop\.ps1'\)/);
  assert.match(install, /'scripts\\harden-acl\.ps1'/);
  assert.match(install, /'scripts\\stop-host\.ps1'/);
  assert.match(build, /'scripts\\harden-acl\.ps1'/);
  assert.match(setup, /function HardenInstallAcl/);
  assert.match(setup, /ExtractTemporaryFile\('harden-acl\.ps1'\)/);
  assert.match(setup, /安装已中止/);
});

test('the standalone uninstaller stops plugin hosts without terminating Codex', () => {
  const uninstall = read(path.join('scripts', 'uninstall.ps1'));
  assert.match(uninstall, /stop-host\.ps1/);
  assert.match(uninstall, /-AllInstances/);
  assert.doesNotMatch(uninstall, /scripts[\\/]stop\.ps1/);
});
