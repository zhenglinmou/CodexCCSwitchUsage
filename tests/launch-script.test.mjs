import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

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
