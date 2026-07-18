$ErrorActionPreference = "Stop"

$appDir = Join-Path $env:LOCALAPPDATA "CCSwitchWafBalanceBridge"
$runtimeFile = Join-Path $appDir "runtime-python.txt"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

$pythonCandidates = @()
if ($env:BALANCE_GATEWAY_PYTHON) {
    $pythonCandidates += $env:BALANCE_GATEWAY_PYTHON
}
$pythonCandidates += (Join-Path $PSScriptRoot ".venv\Scripts\python.exe")
if ($env:CONDA_PREFIX) {
    $pythonCandidates += (Join-Path $env:CONDA_PREFIX "python.exe")
}
$pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pathPython) {
    $pythonCandidates += $pathPython.Source
}

$python = $pythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique -First 1
if (-not $python) {
    throw "没有找到可用的 Python。请安装 Python 3.10+，或通过 BALANCE_GATEWAY_PYTHON 指定 python.exe。"
}

& $python -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "依赖安装失败。"
}
& $python -c "import requests, playwright"
if ($LASTEXITCODE -ne 0) {
    throw "依赖验证失败。"
}
Set-Content -LiteralPath $runtimeFile -Value $python -Encoding utf8NoBOM
Write-Host "依赖安装完成。桥接运行时：$python"
