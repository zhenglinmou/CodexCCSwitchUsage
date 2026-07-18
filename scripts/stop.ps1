param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'),
    [int]$Port = 9334
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$runtime = Join-Path $root 'runtime'
$hostPath = Join-Path $root 'src\host.mjs'

$hosts = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($hostPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
foreach ($hostProcess in $hosts) {
    Stop-Process -Id $hostProcess.ProcessId -Force -ErrorAction SilentlyContinue
}

$all = @(Get-CimInstance Win32_Process)
$roots = @($all | Where-Object {
    $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -and
    $_.CommandLine -notmatch '(?:^|\s)--type=' -and
    $_.CommandLine -match "--remote-debugging-port=$Port(?:\s|$)"
} | Select-Object -ExpandProperty ProcessId)
$kill = @($roots)
do {
    $added = $false
    foreach ($process in $all) {
        if ($process.ParentProcessId -in $kill -and $process.ProcessId -notin $kill) {
            $kill += $process.ProcessId
            $added = $true
        }
    }
} while ($added)
foreach ($processId in ($kill | Sort-Object -Descending -Unique)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 350
if (Test-Path -LiteralPath (Join-Path $runtime 'host.pid')) {
    Remove-Item -LiteralPath (Join-Path $runtime 'host.pid') -Force -ErrorAction SilentlyContinue
}
[pscustomobject]@{ stopped = $true; hostCount = @($hosts).Count; codexRootCount = $roots.Count } | ConvertTo-Json -Compress
