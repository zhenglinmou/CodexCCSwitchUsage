param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "reload", "list", "test", "test-all", "login", "code", "log")]
    [string]$Action = "status",

    [Parameter(Position = 1)]
    [string]$Provider
)

$ErrorActionPreference = "Stop"
$baseUrl = "http://127.0.0.1:17891"

function Get-V1BridgeHealth {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/v1/health" -TimeoutSec 3
    } catch {
        throw "v1 Python 余额桥接器未运行。"
    }
    if (-not $health.success -or $health.service -ne "local-balance-gateway") {
        throw "端口 17891 上运行的不是 v1 Python 余额桥接器。"
    }
    return $health
}

switch ($Action) {
    "start" {
        & (Join-Path $PSScriptRoot "start-bridge.ps1")
    }
    "stop" {
        & (Join-Path $PSScriptRoot "stop-bridge.ps1")
    }
    "status" {
        Get-V1BridgeHealth | ConvertTo-Json -Depth 10
    }
    "reload" {
        Get-V1BridgeHealth | Out-Null
        Invoke-RestMethod -Uri "$baseUrl/v1/reload" -Method Post -TimeoutSec 10 | ConvertTo-Json -Depth 10
    }
    "list" {
        Get-V1BridgeHealth | Out-Null
        Invoke-RestMethod -Uri "$baseUrl/v1/providers" -TimeoutSec 10 | ConvertTo-Json -Depth 10
    }
    "test" {
        if (-not $Provider) { throw "用法：.\manage.ps1 test <provider-id>" }
        Get-V1BridgeHealth | Out-Null
        Invoke-RestMethod -Uri "$baseUrl/v1/balance/$Provider" -TimeoutSec 90 | ConvertTo-Json -Depth 10
    }
    "test-all" {
        Get-V1BridgeHealth | Out-Null
        $result = Invoke-RestMethod -Uri "$baseUrl/v1/balances" -TimeoutSec 180
        $result.data.PSObject.Properties | ForEach-Object {
            $response = $_.Value
            $data = $response.data
            [pscustomobject]@{
                Provider = $_.Name
                Success = $response.success
                Valid = $data.isValid
                Plan = $data.planName
                Remaining = $data.remaining
                Used = $data.used
                Total = $data.total
                Unit = $data.unit
                Extra = $data.extra
                Message = $response.message
            }
        } | Format-Table -AutoSize -Wrap
    }
    "login" {
        if (-not $Provider) { throw "用法：.\manage.ps1 login <provider-id>" }
        Get-V1BridgeHealth | Out-Null
        Invoke-RestMethod -Uri "$baseUrl/v1/login/$Provider" -TimeoutSec 90 | ConvertTo-Json -Depth 10
    }
    "code" {
        if (-not $Provider) { throw "用法：.\manage.ps1 code <provider-id>" }
        Get-V1BridgeHealth | Out-Null
        $result = Invoke-RestMethod -Uri "$baseUrl/v1/cc-switch/$Provider" -TimeoutSec 10
        $result.code
    }
    "log" {
        Get-Content "$env:LOCALAPPDATA\CCSwitchWafBalanceBridge\bridge.log" -Tail 100
    }
}
