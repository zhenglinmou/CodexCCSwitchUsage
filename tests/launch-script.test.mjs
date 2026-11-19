import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Windows activation timeouts recover only when the canonical CDP page becomes ready', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-launch-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'recovery.ps1');
  const launchPath = fileURLToPath(new URL('../scripts/launch.ps1', import.meta.url)).replaceAll("'", "''");
  fs.writeFileSync(fixture, `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${launchPath}', [ref]$null, [ref]$null)
foreach ($name in @('Wait-CodexDebugReady', 'Start-CodexDebugSession', 'Wait-CodexRootExit')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $definition.Extent.Text
}
function Start-Sleep { param($Milliseconds) }
function Start-CodexApplication { throw 'activation timeout' }
$script:queries = 0
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    $script:queries++
    if ($script:queries -eq 1) { throw 'still starting' }
    if ($script:queries -eq 2) { return @([pscustomobject]@{type='page'; url='app://-/index.html?initialRoute=guest'}) }
    return @([pscustomobject]@{type='page'; url='app://-/index.html'})
}
Start-CodexDebugSession -AppUserModelId 'fixture' -DebugPort 12345
$recoveredQueries = $script:queries
function Invoke-RestMethod { return @([pscustomobject]@{type='iframe'; url='app://-/index.html'}) }
$guestReady = Wait-CodexDebugReady -DebugPort 12345 -TimeoutSeconds 0
function Wait-CodexDebugReady { return $false }
$failure = ''
try { Start-CodexDebugSession -AppUserModelId 'fixture' -DebugPort 12345 } catch { $failure = $_.Exception.Message }
$script:checks = 0
function Get-Process {
    param($Id)
    $script:checks++
    if ($script:checks -lt 3) { return [pscustomobject]@{Id=$Id} }
}
$gone = @(Wait-CodexRootExit -Roots @([pscustomobject]@{ProcessId=123}))
function Get-Process { param($Id) return [pscustomobject]@{Id=$Id} }
$stillRunning = @(Wait-CodexRootExit -Roots @([pscustomobject]@{ProcessId=123}) -TimeoutSeconds 0)
[pscustomobject]@{ recoveredQueries=$recoveredQueries; guestReady=$guestReady; failure=$failure; exited=$gone.Count; remaining=$stillRunning.Count } | ConvertTo-Json -Compress
`, 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.deepEqual(JSON.parse(result.trim()), {
    recoveredQueries: 3, guestReady: false, failure: 'activation timeout', exited: 0, remaining: 1,
  });
});

test('launcher automatically restarts an ordinary Codex before enabling the extension', () => {
  const source = fs.readFileSync(new URL('../scripts/launch.ps1', import.meta.url), 'utf8');

  assert.match(source, /\$ordinaryRoots\s*=/);
  assert.match(source, /CloseMainWindow\(\)/);
  assert.doesNotMatch(source, /restartDeclined/);
  assert.match(source, /\.Popup\(/);
  assert.match(source, /forceRestartDeclined/);
  assert.match(source, /remount\.request/);
});

test('launcher starts the host before foreground window activation work', () => {
  const source = fs.readFileSync(new URL('../scripts/launch.ps1', import.meta.url), 'utf8');
  assert.ok(source.indexOf("$hostPath = Join-Path $root 'src\\host.mjs'") < source.indexOf('$windowActivated ='));
  assert.ok(source.indexOf('[int]$codexProcessId = $codexRoot.ProcessId') < source.indexOf("$hostPath = Join-Path $root 'src\\host.mjs'"));
});

test('launcher activates packaged Codex through its AppUserModelId', () => {
  const source = fs.readFileSync(new URL('../scripts/launch.ps1', import.meta.url), 'utf8');

  assert.match(source, /IApplicationActivationManager/);
  assert.match(source, /ActivateApplication/);
  assert.match(source, /PackageFamilyName/);
  assert.doesNotMatch(source, /Start-Process -FilePath \$codexExe/);
});

test('packaged launcher starts Node detached while source mode keeps its fallback', () => {
  const source = fs.readFileSync(new URL('../scripts/launch.ps1', import.meta.url), 'utf8');

  assert.match(source, /\$packagedLauncher = Join-Path \$root 'CodexCCSwitchUsage\.exe'/);
  assert.match(source, /'--start-host'/);
  assert.equal((source.match(/'--codex-pid', \$codexProcessId/g) || []).length, 2);
  assert.match(source, /\$hostMatchesCodex/);
  assert.match(source, /Stop-Process -Id \$hostProcess\.ProcessId/);
  assert.match(source, /-WindowStyle Hidden -PassThru\s+\$hostStart\.WaitForExit\(\)/);
  assert.doesNotMatch(source, /-WindowStyle Hidden -Wait -PassThru/);
  assert.match(source, /else \{\s*\$node = \(Get-Command node\.exe/);
  assert.match(source, /-RedirectStandardOutput/);
  assert.match(source, /-RedirectStandardError/);
});

test('launcher reuses a live Codex root and only rescans after it becomes unavailable', () => {
  const source = fs.readFileSync(new URL('../scripts/launch.ps1', import.meta.url), 'utf8');

  assert.equal(
    (source.match(/Get-CimInstance Win32_Process \| Where-Object/g) || []).length,
    1,
    'the full process enumeration should only remain inside Get-CodexRoots',
  );
  assert.match(source, /if \(\$codexRoot\) \{[\s\S]*Get-Process -Id \$codexRoot\.ProcessId[\s\S]*\}/);
  assert.match(source, /if \(-not \$codexRoot\) \{\s*\$codexRoot = Get-CodexRoots \| Where-Object/);
});
