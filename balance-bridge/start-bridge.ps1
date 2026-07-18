$ErrorActionPreference = "Stop"

$healthUrl = "http://127.0.0.1:17891/v1/health"
$scriptPath = Join-Path $PSScriptRoot "bridge.py"
$configPath = Join-Path $PSScriptRoot "providers.json"
$appDir = Join-Path $env:LOCALAPPDATA "CCSwitchWafBalanceBridge"
$runtimeFile = Join-Path $appDir "runtime-python.txt"

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "配置文件不存在：$configPath。请先复制 providers.ccswitch.example.json 或 providers.example.json 为 providers.json，并按说明填写。"
}

$health = $null
try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
} catch {}
if ($health.success) {
    if ($health.service -eq "local-balance-gateway") {
        Write-Host "本地余额网关已经在运行。"
        exit 0
    }
    throw "端口 17891 已被其他服务占用。不要让 v1 Python 桥接器与 v2 Balance Hub 同时运行。"
}

New-Item -ItemType Directory -Force -Path $appDir | Out-Null

$pythonCandidates = @()
if ($env:BALANCE_GATEWAY_PYTHON) {
    $pythonCandidates += $env:BALANCE_GATEWAY_PYTHON
}
if (Test-Path -LiteralPath $runtimeFile) {
    $pythonCandidates += (Get-Content -LiteralPath $runtimeFile -Raw).Trim()
}
$pythonCandidates += (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")
if ($env:CONDA_PREFIX) {
    $pythonCandidates += (Join-Path $env:CONDA_PREFIX "python.exe")
}
$pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pathPython) {
    $pythonCandidates += $pathPython.Source
}

$python = $null
foreach ($candidate in ($pythonCandidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate)) {
        continue
    }
    & $candidate -c "import requests, playwright" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $python = $candidate
        break
    }
}

if (-not $python) {
    throw "没有找到已安装桥接依赖的 Python。请先运行 .\install-dependencies.ps1，或通过 BALANCE_GATEWAY_PYTHON 指定 python.exe。"
}
Set-Content -LiteralPath $runtimeFile -Value $python -Encoding utf8NoBOM

$pythonw = Join-Path (Split-Path $python -Parent) "pythonw.exe"
if (-not (Test-Path -LiteralPath $pythonw)) {
    $pythonw = $python
}

Start-Process -FilePath $pythonw -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.success -and $health.service -eq "local-balance-gateway") {
            Write-Host "本地余额网关启动成功：http://127.0.0.1:17891"
            exit 0
        }
    } catch {}
}

throw "本地余额网关启动超时，请查看日志：$env:LOCALAPPDATA\CCSwitchWafBalanceBridge\bridge.log"
