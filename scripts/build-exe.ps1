param(
    [string]$NodeExecutable = '',
    [string]$InnoCompiler = '',
    [string]$SignTool = '',
    [string]$CertificateThumbprint = $env:CODEXCCSWITCH_SIGNING_THUMBPRINT,
    [string]$TimestampUrl = 'https://timestamp.digicert.com',
    [switch]$AllowUnsigned
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$buildRoot = Join-Path $root 'build'
$packageRoot = Join-Path $buildRoot 'package'
$dist = Join-Path $root 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$expectedNodeVersion = [string]$manifest.bundledNodeVersion
if ($expectedNodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json bundledNodeVersion must be an exact semantic version.' }
$CertificateThumbprint = ([string]$CertificateThumbprint -replace '\s', '').ToUpperInvariant()
$signingEnabled = [bool]$CertificateThumbprint
if (-not $signingEnabled -and -not $AllowUnsigned) {
    throw 'A code-signing certificate thumbprint is required. Set CODEXCCSWITCH_SIGNING_THUMBPRINT or pass -AllowUnsigned only for intentionally labeled unsigned artifacts.'
}
if ($signingEnabled -and $CertificateThumbprint -notmatch '^[0-9A-F]{40}$') { throw 'The code-signing certificate thumbprint must be 40 hexadecimal characters.' }
try { $timestampUri = [Uri]$TimestampUrl } catch { throw 'TimestampUrl is invalid.' }
if ($signingEnabled -and ($timestampUri.Scheme -ne 'https' -or $timestampUri.UserInfo)) { throw 'TimestampUrl must be an HTTPS URL without credentials.' }

function Assert-WorkspaceChild {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the workspace: $full"
    }
    return $full
}

$buildRoot = Assert-WorkspaceChild $buildRoot
$packageRoot = Assert-WorkspaceChild $packageRoot
$dist = Assert-WorkspaceChild $dist
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
[IO.Directory]::CreateDirectory($packageRoot) | Out-Null
[IO.Directory]::CreateDirectory($dist) | Out-Null

if (-not $NodeExecutable) {
    $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
}
$NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw "Node executable not found: $NodeExecutable" }
$nodeProbeText = & $NodeExecutable --no-warnings --experimental-sqlite -e "const sqlite=require('node:sqlite');process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,major:Number(process.versions.node.split('.')[0]),sqlite:typeof sqlite.DatabaseSync==='function'}))"
if ($LASTEXITCODE -ne 0) { throw 'The selected Node executable cannot load node:sqlite.' }
$nodeProbe = $nodeProbeText | ConvertFrom-Json
if ($nodeProbe.arch -ne 'x64' -or [string]$nodeProbe.version -ne $expectedNodeVersion -or -not $nodeProbe.sqlite) {
    throw "Node $expectedNodeVersion x64 with node:sqlite is required; found version=$($nodeProbe.version), arch=$($nodeProbe.arch), sqlite=$($nodeProbe.sqlite)."
}

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $sha256.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

function Resolve-SignTool([string]$Requested) {
    if ($Requested) {
        $resolved = [IO.Path]::GetFullPath($Requested)
        if (Test-Path -LiteralPath $resolved -PathType Leaf) { return $resolved }
        throw "signtool.exe not found: $resolved"
    }
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
        foreach ($directory in @(Get-ChildItem -LiteralPath $kitsRoot -Directory | Sort-Object Name -Descending)) {
            $candidate = Join-Path $directory.FullName 'x64\signtool.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    throw 'signtool.exe was not found. Install the Windows SDK signing tools.'
}

function Invoke-CodeSign([string]$Path) {
    & $script:resolvedSignTool sign /fd SHA256 /sha1 $CertificateThumbprint /tr $TimestampUrl /td SHA256 /d 'Codex CCSwitch Usage' $Path
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed: $Path" }
    & $script:resolvedSignTool verify /pa /v $Path | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: $Path" }
}

if ($signingEnabled) {
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
    if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'The requested CurrentUser code-signing certificate or its private key is unavailable.' }
    if (@($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 0) {
        throw 'The requested certificate is not valid for code signing.'
    }
    $script:resolvedSignTool = Resolve-SignTool $SignTool
}

$payloadFiles = @(
    'package.json', 'README.md', 'assets\codex.ico',
    'src\platform.mjs', 'src\provider-repository.mjs', 'src\http-allowlist.mjs', 'src\cdp-client.mjs', 'src\injector-script.mjs',
    'src\browser-callback-broker.mjs', 'src\hub-provider-adapters.mjs', 'src\provider-request-usage.mjs', 'src\provider-templates.mjs', 'src\hub-service.mjs',
    'src\usage-normalization.mjs', 'src\hub-page.mjs', 'src\hub-preferences.mjs', 'src\hub-server.mjs', 'src\companion-auth.mjs', 'src\secure-files.mjs',
    'src\keyed-backoff.mjs', 'src\page-action-channel.mjs', 'src\host-scheduling.mjs', 'src\process-lifecycle.mjs', 'src\target-session.mjs', 'src\host.mjs',
    'scripts\launch.ps1', 'scripts\stop-host.ps1', 'scripts\harden-acl.ps1',
    'browser-companion\manifest.json', 'browser-companion\background.js', 'browser-companion\session-state.js',
    'browser-companion\anyrouter-waf.js', 'browser-companion\protocol.js', 'browser-companion\auth.js',
    'browser-companion\popup.html', 'browser-companion\popup.js', 'browser-companion\README.md'
)
foreach ($relative in $payloadFiles) {
    $source = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Packaging file not found: $relative" }
    $target = Join-Path $packageRoot $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
}

$nodeTarget = Join-Path $packageRoot 'runtime-bin\node.exe'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($nodeTarget)) | Out-Null
Copy-Item -LiteralPath $NodeExecutable -Destination $nodeTarget -Force

$payloadManifestPath = Join-Path $packageRoot 'payload-manifest.sha256'
$payloadManifestLines = @()
foreach ($file in @(Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Sort-Object FullName)) {
    $relative = $file.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
    if (-not $relative -or $relative -match '[\r\n]' -or [IO.Path]::IsPathRooted($relative)) {
        throw "Unsafe payload manifest path: $relative"
    }
    $payloadManifestLines += "$(Get-FileSha256 $file.FullName) *$relative"
}
$payloadManifestText = ($payloadManifestLines -join "`n") + "`n"
[IO.File]::WriteAllText($payloadManifestPath, $payloadManifestText, [Text.UTF8Encoding]::new($false))
$payloadManifestHash = Get-FileSha256 $payloadManifestPath

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) { throw 'The .NET Framework C# compiler was not found.' }

$launcherSource = Join-Path $root 'packaging\launcher\Program.cs'
$launcherVersionSource = Join-Path $buildRoot 'LauncherVersion.cs'
$launcherTarget = Join-Path $packageRoot 'CodexCCSwitchUsage.exe'
$icon = Join-Path $root 'assets\codex.ico'
$versionSegments = @($version.Split('.'))
if ($versionSegments.Count -lt 1 -or $versionSegments.Count -gt 4 -or @($versionSegments | Where-Object { $_ -notmatch '^\d+$' }).Count -gt 0) {
    throw "package.json version must contain one to four numeric segments: $version"
}
while ($versionSegments.Count -lt 4) { $versionSegments += '0' }
if (@($versionSegments | Where-Object { [int64]$_ -gt 65535 }).Count -gt 0) {
    throw "package.json version segments must be at most 65535: $version"
}
$launcherAssemblyVersion = $versionSegments -join '.'
$launcherVersionCode = @"
using System.Reflection;
[assembly: AssemblyVersion("$launcherAssemblyVersion")]
[assembly: AssemblyFileVersion("$launcherAssemblyVersion")]
[assembly: AssemblyInformationalVersion("$version")]
internal static class BuildIntegrity {
    internal const string PayloadManifestSha256 = "$payloadManifestHash";
}
"@
[IO.File]::WriteAllText($launcherVersionSource, $launcherVersionCode, [Text.UTF8Encoding]::new($false))
& $csc /nologo /target:winexe /optimize+ /platform:x64 "/win32icon:$icon" "/out:$launcherTarget" /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll $launcherSource $launcherVersionSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherTarget)) { throw 'Launcher compilation failed.' }
if ($signingEnabled) { Invoke-CodeSign $launcherTarget }

$verification = Start-Process -FilePath $launcherTarget -ArgumentList '--verify' -WorkingDirectory $packageRoot -Wait -PassThru
if ($verification.ExitCode -ne 0) { throw "Launcher verification failed with exit code $($verification.ExitCode)." }

if (-not $InnoCompiler) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    $innoCandidates = @(
        $(if ($command) { $command.Source }),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $InnoCompiler = $innoCandidates | Select-Object -First 1
}
if (-not $InnoCompiler) {
    throw 'Inno Setup 6 was not found. Run: winget install --id JRSoftware.InnoSetup --exact'
}

$setupScript = Join-Path $root 'packaging\setup.iss'
$innoArguments = @('/Qp', "/DAppVersion=$version", "/DPackageRoot=$packageRoot", "/DOutputDir=$dist")
if ($signingEnabled) {
    $innoSignCommand = '"' + $script:resolvedSignTool + '" sign /fd SHA256 /sha1 ' + $CertificateThumbprint + ' /tr ' + $TimestampUrl + ' /td SHA256 /d "Codex CCSwitch Usage" $f'
    $innoArguments += '/DSignedBuild=1'
    $innoArguments += "/Scodexsign=$innoSignCommand"
}
& $InnoCompiler @innoArguments $setupScript
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }

$installer = Join-Path $dist "CodexCCSwitchUsage-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer was not generated: $installer" }
if ($signingEnabled) {
    & $script:resolvedSignTool verify /pa /v $installer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The generated installer does not have a valid Authenticode signature.' }
}
$hash = Get-FileSha256 $installer

[pscustomobject]@{
    built = $true
    version = $version
    installer = $installer
    sizeMB = [Math]::Round((Get-Item -LiteralPath $installer).Length / 1MB, 2)
    sha256 = $hash
    node = $NodeExecutable
    nodeVersion = $nodeProbe.version
    nodeArch = $nodeProbe.arch
    nodeMajor = $nodeProbe.major
    signed = $signingEnabled
} | ConvertTo-Json -Compress
