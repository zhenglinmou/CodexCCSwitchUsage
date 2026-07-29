param(
    [string]$NodeExecutable = '',
    [string]$InnoCompiler = ''
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$buildRoot = Join-Path $root 'build'
$packageRoot = Join-Path $buildRoot 'package'
$dist = Join-Path $root 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version

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
if ($nodeProbe.arch -ne 'x64' -or [int]$nodeProbe.major -lt 22 -or -not $nodeProbe.sqlite) {
    throw "Node 22+ x64 with node:sqlite is required; found arch=$($nodeProbe.arch), major=$($nodeProbe.major), sqlite=$($nodeProbe.sqlite)."
}

$payloadFiles = @(
    'package.json', '.gitignore', 'README.md', 'assets\codex.ico',
    'src\provider-repository.mjs', 'src\evaluator-worker.mjs', 'src\evaluator.mjs',
    'src\usage-client.mjs', 'src\http-allowlist.mjs', 'src\cdp-client.mjs', 'src\injector-script.mjs',
    'src\browser-callback-broker.mjs', 'src\hub-provider-adapters.mjs', 'src\provider-request-usage.mjs', 'src\provider-templates.mjs', 'src\hub-service.mjs',
    'src\hub-page.mjs', 'src\hub-preferences.mjs', 'src\hub-server.mjs',
    'src\keyed-backoff.mjs', 'src\page-action-channel.mjs', 'src\process-lifecycle.mjs', 'src\target-session.mjs', 'src\host.mjs',
    'scripts\install.ps1', 'scripts\launch.ps1', 'scripts\stop.ps1',
    'scripts\stop-host.ps1', 'scripts\harden-acl.ps1', 'scripts\check-current.mjs',
    'scripts\status.ps1', 'scripts\uninstall.ps1',
    'browser-companion\manifest.json', 'browser-companion\background.js', 'browser-companion\session-state.js',
    'browser-companion\anyrouter-waf.js', 'browser-companion\protocol.js',
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
"@
[IO.File]::WriteAllText($launcherVersionSource, $launcherVersionCode, [Text.UTF8Encoding]::new($false))
& $csc /nologo /target:winexe /optimize+ /platform:x64 "/win32icon:$icon" "/out:$launcherTarget" /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll $launcherSource $launcherVersionSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherTarget)) { throw 'Launcher compilation failed.' }

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
& $InnoCompiler /Qp "/DAppVersion=$version" "/DPackageRoot=$packageRoot" "/DOutputDir=$dist" $setupScript
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }

$installer = Join-Path $dist "CodexCCSwitchUsage-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer was not generated: $installer" }
$stream = [IO.File]::OpenRead($installer)
try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
} finally {
    $stream.Dispose()
}

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
} | ConvertTo-Json -Compress
