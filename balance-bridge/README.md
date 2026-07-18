# v1 可选独立 Python 余额桥接器

这是 **CodexCCSwitchUsage v1** 的可选配套组件，也是此前单独保存在本机的桥接工程。它只监听 `127.0.0.1:17891`：CCSwitch 的 `usage_script` 调用统一的本地接口，桥接器再适配不同官方 API、第三方中转站、API Key、OAuth、Cookie 和 WAF。

桥接器与 v1 的 Node 插件是两个独立进程。只在确实需要本地统一网关时启动它；普通 `usage_script` 能直接查询供应商时，不需要桥接器。

> 此目录只属于 `v1`。不要与 v2 Balance Hub 同时运行，因为二者都使用 `127.0.0.1:17891`。启动和停止脚本会核对服务身份，避免误停占用该端口的其他服务。

桥接器按需只读访问 `~/.cc-switch/cc-switch.db`、CCSwitch 既有备份以及 `~/.cli-proxy-api` 中的 Codex 账号令牌。密钥不会复制到仓库，CCSwitch 数据库和现有配额查询脚本也不会被修改。

## 核心目标

- 对外接口固定：`GET /v1/balance/{provider-id}`。
- 常见 JSON API 只改 `providers.json`，不改 Python。
- 内置 CCSwitch 插件保留原桥接工程已实现的 OpenAI、AnyRouter、AgentRouter、PackyCode、DeepSeek、滚动窗口额度和 CPA 账号聚合能力。
- 完全特殊的接口放进独立 Python 插件，不污染网关核心。
- 密钥可以来自环境变量或独立文件，不必明文写进配置。
- 保留旧接口 `/usage/{provider-id}` 和 `/login/{provider-id}`。

## 首次配置与使用

在本目录打开 PowerShell：

```powershell
Copy-Item .\providers.ccswitch.example.json .\providers.json
# 编辑 providers.json，把 replace-with-...-provider-id 替换为本机 CCSwitch provider ID

.\install-dependencies.ps1
.\manage.ps1 start
.\manage.ps1 status
.\manage.ps1 list
.\manage.ps1 test-all
.\manage.ps1 test anyrouter
.\manage.ps1 code anyrouter
.\manage.ps1 stop
```

如果只需要通用 HTTP、浏览器或插件示例，可改为复制 `providers.example.json`。`providers.json` 是本机运行配置，已由 `.gitignore` 排除；不要提交 API Key、Cookie、Token 或本机实际配置。

如果 PowerShell 阻止脚本执行：

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File ".\manage.ps1" start
```

也可以显式指定 Python：

```powershell
$env:BALANCE_GATEWAY_PYTHON = "C:\Path\To\python.exe"
.\install-dependencies.ps1
```

## 接口

| 方法 | 地址 | 用途 |
|---|---|---|
| GET | `/v1/health` | 服务状态 |
| GET | `/v1/providers` | 列出供应商，不返回密钥 |
| GET | `/v1/balance/{id}` | 查询单个余额 |
| GET | `/v1/balances` | 查询所有已启用供应商 |
| GET | `/v1/login/{id}` | 打开该供应商的专用 Edge 登录页 |
| GET | `/v1/cc-switch/{id}` | 生成可粘贴到 CC Switch 的脚本 |
| POST | `/v1/reload` | 修改配置后热重载 |
| POST | `/v1/shutdown` | 正常停止服务 |

### 内置 CCSwitch 插件支持的配置模式

`providers.ccswitch.example.json` 保留了原桥接工程的完整配置结构，但所有 `cc_switch_provider_id` 都已替换为占位符。每台机器上的 provider ID 不同，必须按本机 CCSwitch 数据库或界面中的实际值填写。

| 示例 ID | 能力 | 查询来源 |
|---|---|---|
| `anyrouter` | AnyRouter 国外入口 | CCSwitch 已保存 Cookie + 本地 WAF 计算 |
| `anyrouter_cn` | AnyRouter 国内镜像 | 与 AnyRouter 后台账号共享余额 |
| `openai_official` | OpenAI 账号 | OpenAI 用量接口，可优先使用 CPA 中同账号的新令牌 |
| `openai_personal` | 第二个 OpenAI 账号 | OpenAI 用量接口 |
| `packycode` | PackyCode | API Key 直查 |
| `paid_rawchat` | 滚动窗口供应商 | API Key 直查 3 小时/日窗口 |
| `paid_sharedchat` | 第二个滚动窗口供应商 | API Key 直查 3 小时/日窗口 |
| `deepseek` | DeepSeek | DeepSeek 官方余额接口 |
| `chy` | 仅健康状态的供应商 | API Key 状态 + CCSwitch 本地用量；站点无公开余额接口 |
| `cpa` | CPA 账号聚合 | 汇总 CLIProxyAPI 托管的 Codex 账号用量窗口 |
| `agentrouter` | AgentRouter | CCSwitch Token/User ID + 后台无界面 WAF 验证 |

`isValid=false` 表示接口正常返回了真实状态，但账号登录失效、Key 无效或没有可查询余额；它不是桥接宕机。

统一成功响应：

```json
{
  "success": true,
  "provider": "anyrouter",
  "data": {
    "planName": "default",
    "remaining": 396.4,
    "used": 3.6,
    "total": 400.0,
    "unit": "USD",
    "requestCount": 49,
    "extra": "请求次数：49",
    "isValid": true
  }
}
```

供应商没有公开某个值时，对应字段可以是 `null`。官方 API 不一定提供“剩余额度”；有些只提供消费金额，此时网关不会伪造余额。

限额不是固定周期。带时间窗口的供应商会额外返回 `limits`：

```json
{
  "primaryLimitId": "1d",
  "limits": [
    {"id": "3h", "label": "3小时滚动窗口", "windowSeconds": 10800, "remaining": 20, "used": 10, "total": 30, "unit": "USD", "resetAt": "..."},
    {"id": "1d", "label": "24小时额度", "windowSeconds": 86400, "remaining": 70, "used": 30, "total": 100, "unit": "USD", "resetAt": "..."}
  ]
}
```

顶层 `remaining/used/total` 只是给旧客户端兼容使用，对应 `primaryLimitId` 指定的主窗口。真实的 3 小时、5 小时、24 小时、7 天、月度等额度都分别保存在 `limits`，不会相加或互相覆盖。窗口名称、字段路径和主窗口都在供应商配置中定义。

## 配置文件

实际配置是不会被 Git 跟踪的 `providers.json`：

- `providers.ccswitch.example.json`：原 v1 桥接器的 CCSwitch 专用配置结构，provider ID 已脱敏。
- `providers.example.json`：`generic_http`、`browser_fetch` 和 `python_plugin` 三类通用示例。

选择一个模板复制为 `providers.json` 后再修改。不要直接重命名或覆盖示例文件，以便后续比较更新。

修改后不必重启：

```powershell
.\manage.ps1 reload
```

改了监听地址或端口才需要停止并重新启动。

### 方式一：普通 HTTP/官方 API

使用 `generic_http`。支持 GET、POST、请求头、JSON 请求体、点路径、数组索引、`[*]` 通配符、求和、计数、最大值、最小值、乘除和四舍五入。

```json
{
  "id": "my-provider",
  "name": "我的供应商",
  "enabled": true,
  "adapter": "generic_http",
  "base_url": "https://api.example.com",
  "request": {
    "path": "/v1/account/balance",
    "method": "GET",
    "headers": {
      "Authorization": "Bearer ${ENV:MY_PROVIDER_KEY}"
    }
  },
  "response": {
    "success": {"path": "success", "equals": true},
    "message_paths": ["message", "error.message"],
    "fields": {
      "planName": {"path": "data.plan", "default": "默认套餐"},
      "remaining": {"path": "data.balance"},
      "used": {"path": "data.used"},
      "total": {"paths": ["data.balance", "data.used"], "aggregate": "sum"},
      "unit": {"path": "data.currency", "default": "USD"}
    }
  }
}
```

数组金额求和示例：

```json
{"path": "data[*].results[*].amount.value", "aggregate": "sum", "round": 4}
```

配额换算示例，原站 `500000` 单位等于 `1 USD`：

```json
{"path": "data.quota", "divisor": 500000}
```

### 方式二：网页登录、Cookie 或 WAF（备用能力）

使用 `browser_fetch` 时网关在目标网站同源页面内执行请求。AgentRouter 使用无界面模式自动完成 WAF 验证，不会弹出窗口；Token 和 User ID 每次从 CC Switch 数据库只读获取。普通已打开的 Edge 若没有以远程调试模式启动，外部程序无法安全接管，因此不是默认方案。

```json
{
  "id": "my-browser-site",
  "name": "网页登录站点",
  "adapter": "browser_fetch",
  "base_url": "https://console.example.com",
  "login_path": "/login",
  "fallback_user_id": "123456",
  "request": {
    "path": "/api/user/self",
    "method": "GET",
    "headers": {"Accept": "application/json"},
    "browser_user_header": "New-Api-User"
  },
  "response": {
    "success": {"path": "success", "equals": true},
    "fields": {
      "remaining": {"path": "data.quota", "divisor": 500000},
      "used": {"path": "data.used_quota", "divisor": 500000},
      "total": {"paths": ["data.quota", "data.used_quota"], "aggregate": "sum", "divisor": 500000},
      "unit": {"default": "USD"}
    }
  }
}
```

添加后执行：

```powershell
.\manage.ps1 reload
.\manage.ps1 login my-browser-site
.\manage.ps1 test my-browser-site
```

### 方式三：特殊 Python 插件

接口涉及签名、分页、多次请求、复杂账单计算或特殊 OAuth 时，使用 `python_plugin`：

```json
{
  "id": "special-provider",
  "name": "特殊供应商",
  "adapter": "python_plugin",
  "plugin": "plugins/special_provider.py",
  "settings": {
    "api_key": "${ENV:SPECIAL_PROVIDER_KEY}"
  }
}
```

插件导出 `query(provider)`，并返回统一结构。模板见 `plugins/example_plugin.py`。插件路径被限制在项目目录内。

## 密钥管理

环境变量可嵌入任意字符串：

```json
"Authorization": "Bearer ${ENV:OPENAI_ADMIN_KEY}"
```

也可以从文件读取：

```json
"Authorization": "Bearer ${FILE:C:\\Secrets\\provider-key.txt}"
```

网关的 `/v1/providers`、日志和错误响应都不会主动输出完整配置或密钥。`providers.json` 如果包含明文密钥，不要上传或分享。

## CC Switch

先用下面的命令确认所有结果：

```powershell
.\manage.ps1 test-all
```

确认某一家可用后，生成对应的 v1 `usage_script`：

```powershell
.\manage.ps1 code my-provider
```

把输出粘贴到 CCSwitch 的“自定义用量查询”，超时建议设为 30～90 秒。v1 Node 插件继续按原有方式执行这个 `usage_script`；它只看到标准化后的本地网关响应。

## 开机启动与日志

安装开机启动：

```powershell
.\install-startup.ps1
```

查看最近日志：

```powershell
.\manage.ps1 log
```

日志路径：

```text
%LOCALAPPDATA%\CCSwitchWafBalanceBridge\bridge.log
```

## 文件结构

```text
bridge.py                         启动入口
providers.json                   本机实际配置（不提交）
providers.ccswitch.example.json  v1 CCSwitch 专用脱敏模板
providers.example.json           三类适配器示例
manage.ps1                       日常管理命令
balance_gateway/config.py        配置与密钥解析
balance_gateway/mapping.py       JSON 字段提取与换算
balance_gateway/gateway.py       统一查询调度
balance_gateway/app.py           本地 HTTP 服务
balance_gateway/adapters/        内置适配器
plugins/                          特殊供应商插件
tests/                            Python 单元测试
```

## 测试

在 `balance-bridge` 目录运行：

```powershell
python -m unittest discover -s tests -v
```

测试不会修改 CCSwitch 数据库，也不会读取或输出真实密钥。
