$ErrorActionPreference = "SilentlyContinue"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:17891/v1/health" -TimeoutSec 3
if (-not $health.success) {
    Write-Host "本地余额网关未运行。"
    exit 0
}
if ($health.service -ne "local-balance-gateway") {
    Write-Host "端口 17891 上运行的不是 v1 Python 桥接器，已拒绝发送停止请求。"
    exit 1
}

$result = Invoke-RestMethod -Uri "http://127.0.0.1:17891/v1/shutdown" -Method Post -TimeoutSec 5
if ($result.success) {
    Write-Host "本地余额网关已停止。"
} else {
    Write-Host "本地余额网关未运行。"
}
