param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'))
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$statusPath = Join-Path $root 'runtime\status.json'
$status = if (Test-Path -LiteralPath $statusPath) {
    try { Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
} else { $null }

$hostPath = Join-Path $root 'src\host.mjs'
$hostProcess = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($hostPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | Select-Object -First 1

[pscustomobject]@{
    installed = Test-Path -LiteralPath (Join-Path $root 'package.json')
    running = [bool]$hostProcess
    processId = if ($hostProcess) { $hostProcess.ProcessId } else { $null }
    instanceGuardRunning = $false
    instanceGuardProcessId = $null
    provider = $status.provider
    usageStatus = $status.usageStatus
    connectedPages = $status.connectedPages
    updatedAt = $status.updatedAt
    error = if ($status.error) { $status.error } elseif ($status.connectionError) { $status.connectionError } else { $null }
} | ConvertTo-Json -Compress
