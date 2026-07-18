param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexCCSwitchUsage'),
    [int]$Port = 9334
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$marker = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw "扩展尚未安装：$root" }
$packageMarker = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
if ($packageMarker.name -ne 'codex-ccswitch-usage') { throw '扩展安装标识不匹配。' }

$runtime = Join-Path $root 'runtime'
[IO.Directory]::CreateDirectory($runtime) | Out-Null

function Find-CodexApplication {
    $package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if ($package) {
        return [pscustomobject]@{
            PackageFamilyName = $package.PackageFamilyName
            AppUserModelId = "$($package.PackageFamilyName)!App"
        }
    }
    throw '没有找到 Codex App。'
}

function Start-CodexApplication {
    param([string]$AppUserModelId, [string[]]$Arguments)
    if (-not ('CodexUsage.PackagedApplication' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace CodexUsage {
    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    internal class ApplicationActivationManager { }

    public static class PackagedApplication {
        public static uint Activate(string appUserModelId, string arguments) {
            IApplicationActivationManager manager =
                (IApplicationActivationManager)new ApplicationActivationManager();
            try {
                uint processId;
                int result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
                Marshal.ThrowExceptionForHR(result);
                return processId;
            } finally {
                if (Marshal.IsComObject(manager)) Marshal.FinalReleaseComObject(manager);
            }
        }
    }
}
'@
    }
    $argumentLine = [string]::Join(' ', $Arguments)
    return [CodexUsage.PackagedApplication]::Activate($AppUserModelId, $argumentLine)
}

function Show-CodexWindow {
    param([int]$CodexProcessId)
    if (-not ('CodexUsage.NativeWindow' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace CodexUsage {
    public static class NativeWindow {
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}
'@
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $process = Get-Process -Id $CodexProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) {
            $handle = [IntPtr]$process.MainWindowHandle
            [void][CodexUsage.NativeWindow]::ShowWindowAsync($handle, 9)
            [void][CodexUsage.NativeWindow]::SetForegroundWindow($handle)
            return $true
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-CodexRoots {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -and
        $_.CommandLine -notmatch '(?:^|\s)--type='
    })
}

function Show-RestartPrompt {
    param([string]$Message, [string]$Title, [int]$Icon = 48)
    $shell = New-Object -ComObject WScript.Shell
    return $shell.Popup($Message, 0, $Title, 4 + $Icon + 4096)
}

$codexApplication = Find-CodexApplication
$roots = Get-CodexRoots
$codexRoot = $roots | Where-Object { $_.CommandLine -match "--remote-debugging-port=$Port(?:\s|$)" } | Select-Object -First 1
$ordinaryRoots = @($roots | Where-Object { $_.CommandLine -notmatch "--remote-debugging-port=$Port(?:\s|$)" })

if (-not $codexRoot -and $ordinaryRoots.Count -gt 0) {
    foreach ($rootProcess in $ordinaryRoots) {
        $process = Get-Process -Id $rootProcess.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $remainingRoots = @(Get-CodexRoots | Where-Object { $_.ProcessId -in $ordinaryRoots.ProcessId })
    } while ($remainingRoots.Count -gt 0 -and [DateTime]::UtcNow -lt $closeDeadline)

    if ($remainingRoots.Count -gt 0) {
        $forceAnswer = Show-RestartPrompt `
            -Title 'Codex 未能正常退出' `
            -Icon 16 `
            -Message "Codex 在 10 秒内没有正常退出。`n`n是否强制结束进程并启用额度扩展？"
        if ($forceAnswer -ne 6) {
            [void](Show-CodexWindow -CodexProcessId $remainingRoots[0].ProcessId)
            [pscustomobject]@{ launched = $false; forceRestartDeclined = $true; processId = $remainingRoots[0].ProcessId } | ConvertTo-Json -Compress
            exit 0
        }
        foreach ($rootProcess in $remainingRoots) {
            Stop-Process -Id $rootProcess.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
    }
}

if (-not $codexRoot) {
    [void](Start-CodexApplication -AppUserModelId $codexApplication.AppUserModelId -Arguments @(
        "--remote-debugging-port=$Port",
        "--remote-allow-origins=http://127.0.0.1:$Port",
        '--no-first-run'
    ))
}

$deadline = [DateTime]::UtcNow.AddSeconds(25)
$debugUrls = @(
    "http://127.0.0.1:$Port/json/list",
    "http://[::1]:$Port/json/list"
)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($debugUrl in $debugUrls) {
        try {
            $targets = Invoke-RestMethod -Uri $debugUrl -TimeoutSec 1
            if (@($targets | Where-Object { $_.type -eq 'page' -and $_.url -like 'app://*' }).Count -gt 0) {
                $ready = $true
                break
            }
        } catch {}
    }
    if ($ready) { break }
    Start-Sleep -Milliseconds 300
}
if (-not $ready) { throw 'Codex 已启动，但本地调试接口未就绪。' }

if ($codexRoot) {
    $liveCodexRoot = Get-Process -Id $codexRoot.ProcessId -ErrorAction SilentlyContinue
    if (-not $liveCodexRoot) { $codexRoot = $null }
}
if (-not $codexRoot) {
    $codexRoot = Get-CodexRoots | Where-Object {
        $_.CommandLine -match "--remote-debugging-port=$Port(?:\s|$)"
    } | Select-Object -First 1
}
if (-not $codexRoot) { throw 'Codex 调试接口已就绪，但没有找到对应的根进程。' }
[int]$codexProcessId = $codexRoot.ProcessId

$hostPath = Join-Path $root 'src\host.mjs'
$pidPath = Join-Path $runtime 'host.pid'
$databasePath = Join-Path $env:USERPROFILE '.cc-switch\cc-switch.db'
[int]$hostProcessId = 0
if (Test-Path -LiteralPath $pidPath) {
    [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$hostProcessId)
}
$hostProcess = if ($hostProcessId -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$hostProcessId" -ErrorAction SilentlyContinue } else { $null }
$hostMatchesSource = [bool]($hostProcess -and $hostProcess.CommandLine -and $hostProcess.CommandLine.IndexOf($hostPath, [StringComparison]::OrdinalIgnoreCase) -ge 0)
$hostMatchesCodex = [bool]($hostMatchesSource -and $hostProcess.CommandLine -match "(?:^|\s)--codex-pid(?:\s+|=)$codexProcessId(?:\s|$)")
if ($hostMatchesSource -and -not $hostMatchesCodex) {
    Stop-Process -Id $hostProcess.ProcessId -Force -ErrorAction Stop
    Wait-Process -Id $hostProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    $hostProcess = $null
}
if (-not $hostMatchesSource -or -not $hostMatchesCodex) {
    $packagedLauncher = Join-Path $root 'CodexCCSwitchUsage.exe'
    if (Test-Path -LiteralPath $packagedLauncher -PathType Leaf) {
        $launcherError = Join-Path $runtime 'launcher-error.log'
        Remove-Item -LiteralPath $launcherError -Force -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText((Join-Path $runtime 'host.log'), '')
        [IO.File]::WriteAllText((Join-Path $runtime 'host-error.log'), '')
        $hostStart = Start-Process -FilePath $packagedLauncher -ArgumentList @(
            '--start-host',
            '--port', $Port,
            '--codex-pid', $codexProcessId,
            '--runtime-dir', ('"' + $runtime + '"'),
            '--database', ('"' + $databasePath + '"')
        ) -WorkingDirectory $root -WindowStyle Hidden -PassThru
        $hostStart.WaitForExit()
        if ($hostStart.ExitCode -ne 0) {
            $detail = if (Test-Path -LiteralPath $launcherError) {
                (Get-Content -LiteralPath $launcherError -Raw).Trim()
            } else {
                "Detached host launcher exited with code $($hostStart.ExitCode)."
            }
            throw $detail
        }
    } else {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        Start-Process -FilePath $node -ArgumentList @(
            '--no-warnings', '--experimental-sqlite',
            ('"' + $hostPath + '"'),
            '--port', $Port,
            '--codex-pid', $codexProcessId,
            '--runtime-dir', ('"' + $runtime + '"'),
            '--database', ('"' + $databasePath + '"')
        ) -WorkingDirectory $root -WindowStyle Hidden `
          -RedirectStandardOutput (Join-Path $runtime 'host.log') `
          -RedirectStandardError (Join-Path $runtime 'host-error.log') | Out-Null
    }
}

$windowActivated = if ($codexRoot) { Show-CodexWindow -CodexProcessId $codexRoot.ProcessId } else { $false }

Set-Content -LiteralPath (Join-Path $runtime 'remount.request') -Value ([DateTime]::UtcNow.ToString('o')) -Encoding ASCII

[pscustomobject]@{
    launched = $true
    port = $Port
    codexProcessId = $codexProcessId
    profile = 'default'
    installRoot = $root
    windowActivated = $windowActivated
} | ConvertTo-Json -Compress
