[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v\d+\.\d+\.\d+(?:\.\d+)?$')]
    [string]$Tag,

    [Parameter(Mandatory = $true)]
    [string]$NotesFile,

    [string]$Repository = '',
    [string]$BrowserExecutable = '',
    [string]$SigningKey = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage\signing\ccswitch-browser-companion.pem'),
    [switch]$CreateSigningKey,
    [switch]$AllowUnsigned,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dist = Join-Path $root 'dist'
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$companionRoot = Join-Path $root 'browser-companion'
$companionManifest = Get-Content -LiteralPath (Join-Path $companionRoot 'manifest.json') -Raw | ConvertFrom-Json
$companionVersion = [string]$companionManifest.version

function Assert-WorkspaceChild {
    param([string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write release artifacts outside the workspace: $full"
    }
    return $full
}

function Resolve-ExistingFile {
    param([string]$Path, [string]$Label)

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $full = [IO.Path]::GetFullPath($resolved.Path)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw "$Label must be a file: $full"
    }
    return $full
}

function Invoke-CheckedNative {
    param([string]$FilePath, [string[]]$Arguments, [string]$Description)

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Get-FileSha256 {
    param([string]$Path)

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

function Assert-NotarizedMacPackage {
    param([string]$Path, [string]$Architecture)

    $recordPath = "$Path.notarized.json"
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) {
        throw "macOS release package is missing its notarization record: $recordPath"
    }
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $actualHash = Get-FileSha256 -Path $Path
    if ($record.version -ne 1 -or
        $record.appVersion -ne $version -or
        $record.architecture -ne $Architecture -or
        $record.notarized -ne $true -or
        $record.sha256 -ne $actualHash) {
        throw "macOS notarization record does not match the release package: $Path"
    }
}

function Resolve-BrowserPacker {
    param([string]$Requested)

    $candidates = @()
    if ($Requested) { $candidates += $Requested }
    foreach ($commandName in @('chrome.exe', 'msedge.exe')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidates += $command.Source }
    }
    $candidates += @(
        'C:\Program Files\Google\Chrome\Application\chrome.exe',
        'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    )

    foreach ($candidate in $candidates | Where-Object { $_ } | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw 'Chrome or Edge is required to create the signed browser companion CRX.'
}

function Set-PrivateKeyAcl {
    param([string]$Directory, [string]$KeyPath)

    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $Directory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to harden the browser companion signing-key directory.' }
    if (Test-Path -LiteralPath $KeyPath) {
        & icacls $KeyPath /inheritance:r /grant:r "${identity}:F" 'SYSTEM:F' 'Administrators:F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to harden the browser companion signing key.' }
    }
}

function Assert-PrivateKeyAcl {
    param([string]$KeyPath)

    $aclText = (& icacls $KeyPath) -join "`n"
    if ($aclText -match 'Everyone|BUILTIN\\Users') {
        throw 'The browser companion signing key has a broad ACL and cannot be used for release packaging.'
    }
}

function Assert-CompanionZip {
    param([string]$Path)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($zip.Entries | ForEach-Object FullName)
        $required = @(
            'browser-companion/manifest.json',
            'browser-companion/background.js',
            'browser-companion/popup.html',
            'browser-companion/popup.js',
            'browser-companion/README.md'
        )
        $missing = @($required | Where-Object { $_ -notin $entries })
        if ($missing.Count) { throw ('Browser companion ZIP is missing: ' + ($missing -join ', ')) }
    } finally {
        $zip.Dispose()
    }
}

function Resolve-GitHubRepository {
    param([string]$Requested)

    if ($Requested) {
        if ($Requested -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
            throw "Repository must use owner/name form: $Requested"
        }
        return $Requested
    }

    $remote = (& git config --get remote.origin.url).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $remote) { throw 'Cannot resolve the GitHub repository from origin.' }
    if ($remote -match '^https://github\.com/(?<repo>[^/]+/[^/]+?)(?:\.git)?$') { return $Matches.repo }
    if ($remote -match '^git@github\.com:(?<repo>[^/]+/[^/]+?)(?:\.git)?$') { return $Matches.repo }
    throw "origin is not a GitHub repository URL: $remote"
}

function Assert-RemoteTag {
    param([string]$ReleaseTag)

    $remoteTag = & git ls-remote --tags origin "refs/tags/$ReleaseTag"
    if ($LASTEXITCODE -ne 0) { throw "Failed to query origin for tag $ReleaseTag." }
    if (-not $remoteTag) { throw "Push tag $ReleaseTag to origin before publishing the release." }
}

if ($Tag -ne "v$version") {
    throw "Release tag $Tag must match package.json version v$version."
}

$notesPath = Resolve-ExistingFile -Path $NotesFile -Label 'Release notes file'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$notes = ([IO.File]::ReadAllText($notesPath, $utf8)).Trim()
if (-not $notes) { throw 'Release notes file cannot be empty.' }

$installer = Assert-WorkspaceChild (Join-Path $dist "CodexCCSwitchUsage-Setup-$version.exe")
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Build the versioned installer before publishing: $installer"
}
$installerSignature = Get-AuthenticodeSignature -LiteralPath $installer
if (-not $AllowUnsigned -and [string]$installerSignature.Status -ne 'Valid') {
    throw "The Windows installer must have a valid Authenticode signature before release publishing: $($installerSignature.StatusMessage)"
}
$macPackageExtension = if ($AllowUnsigned) { 'tar.gz' } else { 'zip' }
$macArm64Package = Assert-WorkspaceChild (Join-Path $dist "CodexCCSwitchUsage-macos-arm64-$version.$macPackageExtension")
$macX64Package = Assert-WorkspaceChild (Join-Path $dist "CodexCCSwitchUsage-macos-x64-$version.$macPackageExtension")
foreach ($macPackage in @($macArm64Package, $macX64Package)) {
    if (-not (Test-Path -LiteralPath $macPackage -PathType Leaf)) {
        throw "Build the macOS package before publishing: $macPackage"
    }
}
if (-not $AllowUnsigned) {
    Assert-NotarizedMacPackage -Path $macArm64Package -Architecture 'arm64'
    Assert-NotarizedMacPackage -Path $macX64Package -Architecture 'x64'
}
if (-not (Test-Path -LiteralPath $companionRoot -PathType Container)) {
    throw "Browser companion source is missing: $companionRoot"
}

$zipPath = Assert-WorkspaceChild (Join-Path $dist "CCSwitch-Browser-Companion-$companionVersion.zip")
$crxPath = Assert-WorkspaceChild (Join-Path $dist "CCSwitch-Browser-Companion-$companionVersion.crx")
$signingKeyPath = [IO.Path]::GetFullPath($SigningKey)
$repositoryName = Resolve-GitHubRepository -Requested $Repository
$packer = Resolve-BrowserPacker -Requested $BrowserExecutable
Assert-RemoteTag -ReleaseTag $Tag

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('codexccswitch-release-' + [guid]::NewGuid().ToString('N'))
try {
    [IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    $zipWork = Join-Path $tempRoot 'browser-companion.zip'
    Compress-Archive -LiteralPath $companionRoot -DestinationPath $zipWork -CompressionLevel Optimal
    Assert-CompanionZip -Path $zipWork
    Copy-Item -LiteralPath $zipWork -Destination $zipPath -Force

    $stagedCompanion = Join-Path $tempRoot 'browser-companion'
    Copy-Item -LiteralPath $companionRoot -Destination $stagedCompanion -Recurse -Force
    $signingDirectory = [IO.Path]::GetDirectoryName($signingKeyPath)
    if (-not (Test-Path -LiteralPath $signingKeyPath -PathType Leaf)) {
        if (-not $CreateSigningKey) {
            throw "Signing key not found: $signingKeyPath. Restore the original key or rerun with -CreateSigningKey only when intentionally creating a new extension identity."
        }
        Set-PrivateKeyAcl -Directory $signingDirectory -KeyPath $signingKeyPath
        $initialPack = Start-Process -FilePath $packer -ArgumentList "--pack-extension=$stagedCompanion" -Wait -PassThru -WindowStyle Hidden
        if ($initialPack.ExitCode -ne 0) { throw "Initial browser companion key generation failed with exit code $($initialPack.ExitCode)." }
        $generatedKey = Join-Path $tempRoot 'browser-companion.pem'
        if (-not (Test-Path -LiteralPath $generatedKey -PathType Leaf)) { throw 'Browser packer did not generate a private signing key.' }
        Copy-Item -LiteralPath $generatedKey -Destination $signingKeyPath -ErrorAction Stop
    }
    Set-PrivateKeyAcl -Directory $signingDirectory -KeyPath $signingKeyPath
    Assert-PrivateKeyAcl -KeyPath $signingKeyPath

    $signedPack = Start-Process -FilePath $packer -ArgumentList "--pack-extension=$stagedCompanion", "--pack-extension-key=$signingKeyPath" -Wait -PassThru -WindowStyle Hidden
    if ($signedPack.ExitCode -ne 0) { throw "Signed browser companion packaging failed with exit code $($signedPack.ExitCode)." }
    $packedCrx = Join-Path $tempRoot 'browser-companion.crx'
    if (-not (Test-Path -LiteralPath $packedCrx -PathType Leaf)) { throw 'Browser packer did not generate a CRX file.' }
    $header = [IO.File]::ReadAllBytes($packedCrx)
    if ($header.Length -lt 8 -or [Text.Encoding]::ASCII.GetString($header, 0, 4) -ne 'Cr24' -or [BitConverter]::ToUInt32($header, 4) -ne 3) {
        throw 'Browser packer output is not a CRX3 package.'
    }
    Copy-Item -LiteralPath $packedCrx -Destination $crxPath -Force

    $installerHash = Get-FileSha256 -Path $installer
    $macArm64Hash = Get-FileSha256 -Path $macArm64Package
    $macX64Hash = Get-FileSha256 -Path $macX64Package
    $zipHash = Get-FileSha256 -Path $zipPath
    $crxHash = Get-FileSha256 -Path $crxPath
    $companionSectionPath = Join-Path $root 'docs\RELEASE_BROWSER_COMPANION_SECTION.md'
    $companionSection = [IO.File]::ReadAllText($companionSectionPath, $utf8)
    $releaseMode = if ($AllowUnsigned) { 'UNSIGNED' } else { 'SIGNED' }
    $trustNoticePath = Join-Path $root "docs\RELEASE_TRUST_$releaseMode.md"
    $macPackageStatusPath = Join-Path $root "docs\RELEASE_MACOS_$releaseMode.md"
    $trustNotice = ([IO.File]::ReadAllText($trustNoticePath, $utf8)).Trim()
    $macPackageStatus = ([IO.File]::ReadAllText($macPackageStatusPath, $utf8)).Trim()
    $replacements = @{
        '{{COMPANION_VERSION}}' = $companionVersion
        '{{APP_VERSION}}' = $version
        '{{RELEASE_TRUST_NOTICE}}' = $trustNotice
        '{{MACOS_ARM64_FILENAME}}' = [IO.Path]::GetFileName($macArm64Package)
        '{{MACOS_X64_FILENAME}}' = [IO.Path]::GetFileName($macX64Package)
        '{{MACOS_PACKAGE_STATUS}}' = $macPackageStatus
        '{{INSTALLER_SHA256}}' = $installerHash
        '{{MACOS_ARM64_SHA256}}' = $macArm64Hash
        '{{MACOS_X64_SHA256}}' = $macX64Hash
        '{{COMPANION_ZIP_SHA256}}' = $zipHash
        '{{COMPANION_CRX_SHA256}}' = $crxHash
    }
    foreach ($replacement in $replacements.GetEnumerator()) {
        $companionSection = $companionSection.Replace($replacement.Key, $replacement.Value)
    }
    if ($companionSection -notmatch '<!-- browser-companion-required:start -->' -or $companionSection -notmatch '<!-- browser-companion-required:end -->') {
        throw 'Browser companion release template is missing its required markers.'
    }
    if ($companionSection -match '\{\{[A-Z0-9_]+\}\}') {
        throw 'Release template contains an unresolved placeholder.'
    }
    $renderedNotes = Join-Path $tempRoot 'release-notes.md'
    $renderedNotesContent = $notes + "`r`n`r`n" + $companionSection.Trim() + "`r`n"
    [IO.File]::WriteAllText($renderedNotes, $renderedNotesContent, $utf8)
    if ([IO.File]::ReadAllText($renderedNotes, $utf8) -cne $renderedNotesContent) {
        throw 'Release notes UTF-8 round-trip validation failed.'
    }

    $assets = @($installer, $macArm64Package, $macX64Package, $zipPath, $crxPath)
    $releaseTitle = if ($AllowUnsigned) { "$Tag (unsigned)" } else { $Tag }
    if ($DryRun) {
        [pscustomobject]@{
            dryRun = $true
            unsigned = [bool]$AllowUnsigned
            tag = $Tag
            title = $releaseTitle
            repository = $repositoryName
            installer = $installer
            macosArm64 = $macArm64Package
            macosX64 = $macX64Package
            companionZip = $zipPath
            companionCrx = $crxPath
            hashes = @{ installer = $installerHash; macosArm64 = $macArm64Hash; macosX64 = $macX64Hash; zip = $zipHash; crx = $crxHash }
            signingKey = $signingKeyPath
        } | ConvertTo-Json -Depth 4 -Compress
        return
    }

    $ghCommand = Get-Command gh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $ghCommand) { $ghCommand = Get-Command gh -ErrorAction Stop | Select-Object -First 1 }
    $gh = $ghCommand.Source
    $releaseProbeOutput = Join-Path $tempRoot 'release-view.out'
    $releaseProbeError = Join-Path $tempRoot 'release-view.err'
    $releaseProbe = Start-Process -FilePath $gh `
        -ArgumentList @('release', 'view', $Tag, '--repo', $repositoryName) `
        -RedirectStandardOutput $releaseProbeOutput `
        -RedirectStandardError $releaseProbeError `
        -Wait -PassThru -WindowStyle Hidden
    if ($releaseProbe.ExitCode -eq 0) {
        $releaseExists = $true
    } else {
        $probeError = if (Test-Path -LiteralPath $releaseProbeError -PathType Leaf) { Get-Content -LiteralPath $releaseProbeError -Raw } else { '' }
        if ($probeError -notmatch '(?i)release not found') {
            throw "Cannot inspect GitHub Release $Tag (gh exit code $($releaseProbe.ExitCode)): $probeError"
        }
        $releaseExists = $false
    }
    if ($releaseExists) {
        Invoke-CheckedNative -FilePath $gh -Arguments (@('release', 'upload', $Tag) + $assets + @('--repo', $repositoryName, '--clobber')) -Description 'GitHub Release asset upload'
        Invoke-CheckedNative -FilePath $gh -Arguments @('release', 'edit', $Tag, '--repo', $repositoryName, '--title', $releaseTitle, '--notes-file', $renderedNotes) -Description 'GitHub Release notes update'
    } else {
        Invoke-CheckedNative -FilePath $gh -Arguments (@('release', 'create', $Tag) + $assets + @('--repo', $repositoryName, '--verify-tag', '--title', $releaseTitle, '--notes-file', $renderedNotes)) -Description 'GitHub Release creation'
    }

    $release = (& $gh release view $Tag --repo $repositoryName --json url,assets,body | ConvertFrom-Json)
    $expectedAssets = @($assets | ForEach-Object { [IO.Path]::GetFileName($_) })
    $releaseAssetNames = @($release.assets | ForEach-Object { $_.name })
    $missingAssets = @($expectedAssets | Where-Object { $_ -notin $releaseAssetNames })
    if ($missingAssets.Count) { throw ('GitHub Release is missing required assets: ' + ($missingAssets -join ', ')) }
    $expectedDigests = @{
        ([IO.Path]::GetFileName($installer)) = "sha256:$installerHash"
        ([IO.Path]::GetFileName($macArm64Package)) = "sha256:$macArm64Hash"
        ([IO.Path]::GetFileName($macX64Package)) = "sha256:$macX64Hash"
        ([IO.Path]::GetFileName($zipPath)) = "sha256:$zipHash"
        ([IO.Path]::GetFileName($crxPath)) = "sha256:$crxHash"
    }
    foreach ($releaseAsset in $release.assets) {
        $expectedDigest = $expectedDigests[$releaseAsset.name]
        if ($expectedDigest -and $releaseAsset.digest -ne $expectedDigest) {
            throw "GitHub Release asset digest does not match local file: $($releaseAsset.name)"
        }
    }
    if ($release.body -notmatch '<!-- browser-companion-required:start -->' -or $release.body -notmatch '<!-- browser-companion-required:end -->') {
        throw 'GitHub Release body is missing the required browser companion instructions.'
    }

    [pscustomobject]@{
        published = $true
        unsigned = [bool]$AllowUnsigned
        tag = $Tag
        title = $releaseTitle
        repository = $repositoryName
        release = $release.url
        installer = $installer
        macosArm64 = $macArm64Package
        macosX64 = $macX64Package
        companionZip = $zipPath
        companionCrx = $crxPath
        hashes = @{ installer = $installerHash; macosArm64 = $macArm64Hash; macosX64 = $macX64Hash; zip = $zipHash; crx = $crxHash }
    } | ConvertTo-Json -Depth 4 -Compress
} finally {
    if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $safeTempRoot = [IO.Path]::GetFullPath($tempRoot)
        if ($safeTempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $safeTempRoot -Recurse -Force
        }
    }
}
