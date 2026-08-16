[CmdletBinding()]
param(
    [string]$NodeVersion = '',
    [string]$OutputRoot = '',
    [string]$DownloadRoot = '',
    [switch]$SkipDownload,
    [string]$CodeSignIdentity = $env:CODEXCCSWITCH_MACOS_SIGNING_IDENTITY,
    [string]$NotaryProfile = $env:CODEXCCSWITCH_MACOS_NOTARY_PROFILE,
    [switch]$AllowUnsigned
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$isMacPlatform = [bool](Get-Variable -Name IsMacOS -ValueOnly -ErrorAction SilentlyContinue)
$signedBuild = [bool]$CodeSignIdentity -or [bool]$NotaryProfile
if ($signedBuild -and (-not $CodeSignIdentity -or -not $NotaryProfile)) {
    throw 'Both CodeSignIdentity and NotaryProfile are required for a signed macOS build.'
}
if ($signedBuild -and -not $isMacPlatform) { throw 'Developer ID signing and notarization must run on macOS.' }
if (-not $signedBuild -and -not $AllowUnsigned) {
    throw 'A Developer ID identity and notarytool Keychain profile are required. Pass -AllowUnsigned only for private test artifacts.'
}
if (-not $NodeVersion) { $NodeVersion = [string]$manifest.bundledNodeVersion }
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json bundledNodeVersion must be an exact semantic version.' }
if (-not $OutputRoot) { $OutputRoot = Join-Path $root 'dist' }
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = [IO.Path]::GetFullPath((Join-Path $root 'build\macos'))
if (-not $DownloadRoot) {
    $localCache = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $localCache) { $localCache = Join-Path $root '.cache' }
    $DownloadRoot = Join-Path $localCache "CodexCCSwitchUsage\downloads\node-v$NodeVersion"
}
$downloadRoot = [IO.Path]::GetFullPath($DownloadRoot)
$nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"
$tarCommand = if ($isMacPlatform) { 'tar' } else { 'tar.exe' }
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
    $payloadFiles = @(
        'package.json',
        'src\platform.mjs', 'src\provider-repository.mjs', 'src\http-allowlist.mjs',
        'src\cdp-client.mjs', 'src\injector-script.mjs', 'src\browser-callback-broker.mjs',
        'src\hub-provider-adapters.mjs', 'src\usage-normalization.mjs', 'src\provider-request-usage.mjs',
        'src\provider-templates.mjs', 'src\hub-service.mjs', 'src\hub-page.mjs',
        'src\hub-preferences.mjs', 'src\hub-server.mjs', 'src\companion-auth.mjs',
        'src\secure-files.mjs', 'src\keyed-backoff.mjs', 'src\page-action-channel.mjs',
        'src\process-lifecycle.mjs', 'src\target-session.mjs', 'src\host.mjs',
        'scripts\launch.mjs', 'scripts\stop-host.mjs',
        'browser-companion\manifest.json', 'browser-companion\background.js',
        'browser-companion\session-state.js', 'browser-companion\anyrouter-waf.js',
        'browser-companion\protocol.js', 'browser-companion\auth.js',
        'browser-companion\popup.html', 'browser-companion\popup.js', 'browser-companion\README.md'
    )
    foreach ($relative in $payloadFiles) {
        if ($relative -match '(?i)(?:^|[\\/])(?:build|dist)(?:[\\/]|$)|\.orig$') { throw "Unsafe packaging entry: $relative" }
        $source = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Packaging file not found: $relative" }
        $target = Join-Path $Destination $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

foreach ($architecture in $architectures) {
    $archivePath = Get-NodeArchive $architecture
    $extractRoot = Join-Path $buildRoot "node-$($architecture.Name)"
    [IO.Directory]::CreateDirectory($extractRoot) | Out-Null
    $nodeArchivePath = "$($architecture.NodeName)/bin/node"
    & $tarCommand -xzf $archivePath -C $extractRoot $nodeArchivePath
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

    $releaseExtension = if ($signedBuild) { 'zip' } else { 'tar.gz' }
    $outputPath = Join-Path $outputRoot "CodexCCSwitchUsage-macos-$($architecture.Name)-$version.$releaseExtension"
    $notarizedRecord = "$outputPath.notarized.json"
    Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$outputPath.sha256" -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $notarizedRecord -Force -ErrorAction SilentlyContinue
    if ($signedBuild) {
        $launcherPath = Join-Path $macosDir 'CodexCCSwitchUsage'
        $stopPath = Join-Path $resources 'stop-host.command'
        $bundledNode = Join-Path $runtimeBin 'node'
        & chmod 755 $launcherPath $stopPath $bundledNode
        if ($LASTEXITCODE -ne 0) { throw "Failed to set executable modes for $($architecture.Name)." }
        $entitlements = Join-Path $root 'packaging\macos\node-entitlements.plist'
        & codesign --force --options runtime --timestamp --entitlements $entitlements --sign $CodeSignIdentity $bundledNode
        if ($LASTEXITCODE -ne 0) { throw "Node code signing failed for $($architecture.Name)." }
        & codesign --force --options runtime --timestamp --sign $CodeSignIdentity $appRoot
        if ($LASTEXITCODE -ne 0) { throw "App code signing failed for $($architecture.Name)." }
        & codesign --verify --deep --strict --verbose=2 $appRoot
        if ($LASTEXITCODE -ne 0) { throw "App signature verification failed for $($architecture.Name)." }

        $notaryZip = Join-Path $buildRoot "$appName.notary.zip"
        Remove-Item -LiteralPath $notaryZip -Force -ErrorAction SilentlyContinue
        & ditto -c -k --sequesterRsrc --keepParent $appRoot $notaryZip
        if ($LASTEXITCODE -ne 0) { throw "Failed to prepare the notarization ZIP for $($architecture.Name)." }
        & xcrun notarytool submit $notaryZip --keychain-profile $NotaryProfile --wait
        if ($LASTEXITCODE -ne 0) { throw "Apple notarization failed for $($architecture.Name)." }
        & xcrun stapler staple $appRoot
        if ($LASTEXITCODE -ne 0) { throw "Notarization ticket stapling failed for $($architecture.Name)." }
        & xcrun stapler validate $appRoot
        if ($LASTEXITCODE -ne 0) { throw "Notarization ticket validation failed for $($architecture.Name)." }
        Remove-Item -LiteralPath $notaryZip -Force -ErrorAction SilentlyContinue
        & ditto -c -k --sequesterRsrc --keepParent $appRoot $outputPath
        if ($LASTEXITCODE -ne 0) { throw "Failed to preserve the signed app and stapled ticket in $outputPath." }
    } else {
        & node (Join-Path $root 'scripts\create-macos-archive.mjs') --root $appRoot --output $outputPath
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
        throw "Failed to create macOS archive: $outputPath"
    }
    $hash = Get-FileSha256 $outputPath
    Set-Content -LiteralPath "$outputPath.sha256" -Value "$hash  $(Split-Path -Leaf $outputPath)" -Encoding ASCII
    if ($signedBuild) {
        $record = [ordered]@{
            version = 1
            appVersion = $version
            architecture = $architecture.Name
            sha256 = $hash
            codeSignIdentity = $CodeSignIdentity
            notarized = $true
        } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($notarizedRecord, $record, [Text.UTF8Encoding]::new($false))
    }
}

[pscustomobject]@{
    built = $true
    version = $version
    outputRoot = $outputRoot
    packages = @(
        "CodexCCSwitchUsage-macos-arm64-$version.$(if ($signedBuild) { 'zip' } else { 'tar.gz' })",
        "CodexCCSwitchUsage-macos-x64-$version.$(if ($signedBuild) { 'zip' } else { 'tar.gz' })"
    )
    signedAndNotarized = $signedBuild
} | ConvertTo-Json -Compress
