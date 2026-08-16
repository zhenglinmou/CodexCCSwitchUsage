param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$marker = Join-Path $root 'package.json'

if (Test-Path -LiteralPath $root) {
    if (-not (Test-Path -LiteralPath $marker)) { throw '扩展标识文件不存在，拒绝删除。' }
    $package = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($package.name -ne 'codex-ccswitch-usage') { throw '扩展标识不匹配，拒绝删除。' }
    $stopHost = Join-Path $root 'scripts\stop-host.ps1'
    if (Test-Path -LiteralPath $stopHost -PathType Leaf) {
        & $stopHost -InstallRoot $root -AllInstances | Out-Null
    }
}

$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex + CCSwitch 用量.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex + CCSwitch 用量.lnk')
)
foreach ($shortcutPath in $shortcutPaths) {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
}
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
[pscustomobject]@{ uninstalled = $true } | ConvertTo-Json -Compress
