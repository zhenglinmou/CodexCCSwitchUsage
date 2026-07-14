param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'),
    [int]$TimeoutSeconds = 5,
    [int]$Port = 9334,
    [switch]$AllInstances
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$runtime = Join-Path $root 'runtime'
$pidPath = Join-Path $runtime 'host.pid'
$hostPath = Join-Path $root 'src\host.mjs'
$candidateIds = [Collections.Generic.HashSet[int]]::new()

function Get-PluginHostRoot {
    param([string]$CommandLine)
    if (-not $CommandLine) { return $null }
    $quoted = [regex]::Match($CommandLine, '(?i)"(?<path>[^"]+[\\/]src[\\/]host\.mjs)"')
    $match = if ($quoted.Success) { $quoted } else { [regex]::Match($CommandLine, '(?i)(?<path>[^\s"]+[\\/]src[\\/]host\.mjs)') }
    if (-not $match.Success) { return $null }
    try {
        $scriptPath = [IO.Path]::GetFullPath($match.Groups['path'].Value)
        $candidateRoot = [IO.Directory]::GetParent([IO.Directory]::GetParent($scriptPath).FullName).FullName
        $marker = Join-Path $candidateRoot 'package.json'
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $null }
        $package = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if ($package.name -ne 'codex-ccswitch-usage') { return $null }
        return $candidateRoot
    } catch {
        return $null
    }
}

function Test-TargetHost {
    param($ProcessInfo)
    if (-not $ProcessInfo -or $ProcessInfo.Name -ne 'node.exe' -or -not $ProcessInfo.CommandLine) { return $false }
    if ($ProcessInfo.CommandLine.IndexOf($hostPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    if (-not $AllInstances) { return $false }
    if ($ProcessInfo.CommandLine -notmatch "(?:^|\s)--port(?:\s+|=)$Port(?:\s|$)") { return $false }
    return [bool](Get-PluginHostRoot $ProcessInfo.CommandLine)
}

if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    [int]$recordedPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$recordedPid) -and $recordedPid -gt 0) {
        [void]$candidateIds.Add($recordedPid)
    }
}

$matchingHosts = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { Test-TargetHost $_ })
foreach ($hostProcess in $matchingHosts) { [void]$candidateIds.Add([int]$hostProcess.ProcessId) }

$stopped = 0
foreach ($processId in $candidateIds) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (-not (Test-TargetHost $candidate)) { continue }
    Stop-Process -Id $processId -Force -ErrorAction Stop
    $stopped += 1
}

$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
do {
    $remaining = @($candidateIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

if ($remaining.Count -gt 0) { throw "Plugin host did not stop: $($remaining -join ', ')" }
if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }

[pscustomobject]@{ stopped = $true; hostCount = $stopped; installRoot = $root; allInstances = [bool]$AllInstances } | ConvertTo-Json -Compress
