param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'))
$ErrorActionPreference = 'Stop'

$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($source -eq $target) { throw '源目录和安装目录不能相同。' }

$marker = Join-Path $target 'package.json'
if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $marker)) { throw "安装目录已存在且不是本扩展：$target" }
    $existing = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($existing.name -ne 'codex-ccswitch-usage') { throw "安装目录标识不匹配：$target" }
    $stopScript = Join-Path $target 'scripts\stop.ps1'
    if (Test-Path -LiteralPath $stopScript) { & $stopScript -InstallRoot $target | Out-Null }
}

[IO.Directory]::CreateDirectory($target) | Out-Null
$files = @(
    'package.json', '.gitignore', 'README.md',
    'src\provider-repository.mjs', 'src\evaluator-worker.mjs', 'src\evaluator.mjs',
    'src\usage-client.mjs', 'src\cdp-client.mjs', 'src\cdp-disconnect-guard.mjs', 'src\browser-callback-broker.mjs', 'src\hub-provider-adapters.mjs',
    'src\hub-service.mjs', 'src\hub-page.mjs', 'src\hub-server.mjs',
    'src\injector-script.mjs', 'src\target-session.mjs', 'src\target-discovery.mjs', 'src\host.mjs',
    'scripts\install.ps1', 'scripts\launch.ps1', 'scripts\stop.ps1', 'scripts\check-current.mjs',
    'scripts\status.ps1', 'scripts\uninstall.ps1',
    'browser-companion\manifest.json', 'browser-companion\background.js',
    'browser-companion\popup.html', 'browser-companion\popup.js', 'browser-companion\README.md'
)
foreach ($relative in $files) {
    $from = Join-Path $source $relative
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "缺少安装文件：$relative" }
    $to = Join-Path $target $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
    Copy-Item -LiteralPath $from -Destination $to -Force
}

foreach ($relative in @('scripts\instance-guard.ps1', 'scripts\migrate-default-profile.ps1')) {
    Remove-Item -LiteralPath (Join-Path $target $relative) -Force -ErrorAction SilentlyContinue
}

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
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $target 'scripts\launch.ps1') + '"'
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
