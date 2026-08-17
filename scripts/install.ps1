param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'))
$ErrorActionPreference = 'Stop'

$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($source -eq $target) { throw '源目录和安装目录不能相同。' }
$aclScript = Join-Path $source 'scripts\harden-acl.ps1'
$stopHostScript = Join-Path $source 'scripts\stop-host.ps1'
if (-not (Test-Path -LiteralPath $aclScript -PathType Leaf)) { throw "缺少 ACL 加固脚本：$aclScript" }
if (-not (Test-Path -LiteralPath $stopHostScript -PathType Leaf)) { throw "缺少宿主停止脚本：$stopHostScript" }

$marker = Join-Path $target 'package.json'
if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $marker)) { throw "安装目录已存在且不是本扩展：$target" }
    $existing = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($existing.name -ne 'codex-ccswitch-usage') { throw "安装目录标识不匹配：$target" }
    & $stopHostScript -InstallRoot $target -AllInstances | Out-Null
}

[IO.Directory]::CreateDirectory($target) | Out-Null
& $aclScript -InstallRoot $target
$files = @(
    'package.json', 'README.md',
    'src\platform.mjs', 'src\provider-repository.mjs', 'src\http-allowlist.mjs', 'src\cdp-client.mjs', 'src\browser-callback-broker.mjs', 'src\hub-provider-adapters.mjs', 'src\provider-request-usage.mjs', 'src\provider-templates.mjs',
    'src\usage-normalization.mjs', 'src\hub-service.mjs', 'src\hub-page.mjs', 'src\hub-preferences.mjs', 'src\hub-server.mjs', 'src\companion-auth.mjs', 'src\secure-files.mjs',
    'src\injector-script.mjs', 'src\keyed-backoff.mjs', 'src\page-action-channel.mjs', 'src\host-scheduling.mjs', 'src\process-lifecycle.mjs', 'src\target-session.mjs', 'src\host.mjs',
    'scripts\launch.ps1', 'scripts\stop-host.ps1', 'scripts\harden-acl.ps1',
    'scripts\status.ps1', 'scripts\uninstall.ps1',
    'browser-companion\manifest.json', 'browser-companion\background.js', 'browser-companion\session-state.js',
    'browser-companion\anyrouter-waf.js', 'browser-companion\protocol.js', 'browser-companion\auth.js',
    'browser-companion\popup.html', 'browser-companion\popup.js', 'browser-companion\README.md'
)
foreach ($relative in $files) {
    $from = Join-Path $source $relative
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "缺少安装文件：$relative" }
    $to = Join-Path $target $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
    Copy-Item -LiteralPath $from -Destination $to -Force
}

Remove-Item -LiteralPath (Join-Path $target 'scripts\migrate-default-profile.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $target 'scripts\check-current.mjs') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $target 'scripts\install.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $target 'scripts\stop.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $target 'src\usage-client.mjs') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $target 'src\evaluator.mjs') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $target 'src\evaluator-worker.mjs') -Force -ErrorAction SilentlyContinue

function Find-CodexExecutable {
    $running = Get-Process ChatGPT -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like '*OpenAI.Codex_*\app\ChatGPT.exe' } |
        Select-Object -First 1
    if ($running) { return $running.Path }
    $package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if ($package) {
        $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw '没有找到 Codex App。'
}

$codexExe = Find-CodexExecutable
$shell = New-Object -ComObject WScript.Shell
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex + CCSwitch 用量.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex + CCSwitch 用量.lnk')
)
foreach ($shortcutPath in $shortcutPaths) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($shortcutPath)) | Out-Null
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Get-Command powershell.exe).Source
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $target 'scripts\launch.ps1') + '" -AllowCodexRestart'
    $shortcut.WorkingDirectory = $target
    $shortcut.IconLocation = "$codexExe,0"
    $shortcut.Description = '启动带 CCSwitch 用量显示的 Codex'
    $shortcut.Save()
}

[pscustomobject]@{
    installed = $true
    installRoot = $target
    desktopShortcut = $shortcutPaths[0]
} | ConvertTo-Json -Compress
