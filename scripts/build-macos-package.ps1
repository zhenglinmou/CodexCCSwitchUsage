[CmdletBinding()]
param(
    [string]$NodeVersion = '22.22.1',
    [string]$OutputRoot = '',
    [switch]$SkipDownload
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if (-not $OutputRoot) { $OutputRoot = Join-Path $root 'dist' }
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = [IO.Path]::GetFullPath((Join-Path $root 'build\macos'))
$downloadRoot = Join-Path $buildRoot 'downloads'
$nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"
$architectures = @(
    @{ Name = 'arm64'; NodeName = "node-v$NodeVersion-darwin-arm64" },
    @{ Name = 'x64'; NodeName = "node-v$NodeVersion-darwin-x64" }
)

if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
[IO.Directory]::CreateDirectory($downloadRoot) | Out-Null
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

$checksumsPath = Join-Path $downloadRoot 'SHASUMS256.txt'
if (-not (Test-Path -LiteralPath $checksumsPath -PathType Leaf)) {
    if ($SkipDownload) { throw "Missing Node checksum file: $checksumsPath" }
    Invoke-WebRequest -Uri "$nodeBaseUrl/SHASUMS256.txt" -OutFile $checksumsPath
}
$checksums = Get-Content -LiteralPath $checksumsPath

function Get-NodeArchive([hashtable]$Architecture) {
    $archiveName = "$($Architecture.NodeName).tar.gz"
    $archivePath = Join-Path $downloadRoot $archiveName
    $checksumLine = $checksums | Where-Object { $_ -match "\s$([regex]::Escape($archiveName))$" } | Select-Object -First 1
    if (-not $checksumLine) { throw "Node archive checksum is missing: $archiveName" }
    $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
        if ($SkipDownload) { throw "Missing Node archive: $archivePath" }
        Invoke-WebRequest -Uri "$nodeBaseUrl/$archiveName" -OutFile $archivePath
    }
    $actualHash = Get-FileSha256 $archivePath
    if ($actualHash -ne $expectedHash) { throw "Node archive checksum mismatch: $archiveName" }
    return $archivePath
}

function Copy-SourcePayload([string]$Destination) {
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $Destination 'package.json') -Force
    Copy-Item -LiteralPath (Join-Path $root 'src') -Destination (Join-Path $Destination 'src') -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $root 'browser-companion') -Destination (Join-Path $Destination 'browser-companion') -Recurse -Force
    [IO.Directory]::CreateDirectory((Join-Path $Destination 'scripts')) | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'scripts\launch.mjs') -Destination (Join-Path $Destination 'scripts\launch.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $root 'scripts\stop-host.mjs') -Destination (Join-Path $Destination 'scripts\stop-host.mjs') -Force
}

foreach ($architecture in $architectures) {
    $archivePath = Get-NodeArchive $architecture
    $extractRoot = Join-Path $buildRoot "node-$($architecture.Name)"
    [IO.Directory]::CreateDirectory($extractRoot) | Out-Null
    $nodeArchivePath = "$($architecture.NodeName)/bin/node"
    & tar.exe -xzf $archivePath -C $extractRoot $nodeArchivePath
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract Node runtime for $($architecture.Name)." }

    $appName = "CodexCCSwitchUsage-macOS-$($architecture.Name).app"
    $appRoot = Join-Path $buildRoot $appName
    $contents = Join-Path $appRoot 'Contents'
    $macosDir = Join-Path $contents 'MacOS'
    $resources = Join-Path $contents 'Resources'
    $runtimeBin = Join-Path $resources 'runtime-bin'
    [IO.Directory]::CreateDirectory($macosDir) | Out-Null
    [IO.Directory]::CreateDirectory($runtimeBin) | Out-Null

    $plist = Get-Content -LiteralPath (Join-Path $root 'packaging\macos\Info.plist') -Raw
    $plist = $plist.Replace('@VERSION@', $version).Replace('@ARCH@', $architecture.Name)
    [IO.File]::WriteAllText((Join-Path $contents 'Info.plist'), $plist, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $root 'packaging\macos\CodexCCSwitchUsage') -Destination (Join-Path $macosDir 'CodexCCSwitchUsage') -Force
    Copy-Item -LiteralPath (Join-Path $root 'packaging\macos\stop-host.command') -Destination (Join-Path $resources 'stop-host.command') -Force
    Copy-Item -LiteralPath (Join-Path $root 'packaging\macos\README.txt') -Destination (Join-Path $resources 'README.txt') -Force
    Copy-SourcePayload -Destination (Join-Path $resources 'app')

    $nodePath = Join-Path $extractRoot "$($architecture.NodeName)\bin\node"
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node runtime was not found after extraction: $nodePath" }
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeBin 'node') -Force

    $outputPath = Join-Path $outputRoot "CodexCCSwitchUsage-macos-$($architecture.Name)-$version.tar.gz"
    & node (Join-Path $root 'scripts\create-macos-archive.mjs') --root $appRoot --output $outputPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
        throw "Failed to create macOS archive: $outputPath"
    }
    $hash = Get-FileSha256 $outputPath
    Set-Content -LiteralPath "$outputPath.sha256" -Value "$hash  $(Split-Path -Leaf $outputPath)" -Encoding ASCII
}

[pscustomobject]@{
    built = $true
    version = $version
    outputRoot = $outputRoot
    packages = @(
        "CodexCCSwitchUsage-macos-arm64-$version.tar.gz",
        "CodexCCSwitchUsage-macos-x64-$version.tar.gz"
    )
} | ConvertTo-Json -Compress
