# Codex CCSwitch Usage

一个 Windows 本地扩展：把 CCSwitch 当前 Codex 供应商的用量嵌入 Codex 输入栏，并提供一个统一管理全部 Codex / GPT 供应商的 Balance Hub。

## v2.0.0 分支

`v2` 在保留原有余额条的基础上增加：

- 自动读取 CCSwitch 中全部 `app_type=codex` 供应商，不维护第二份账号清单。
- 点击余额文字打开本机 Balance Hub；窄窗口时可从额度弹层进入。
- 并发查询全部供应商，统一展示已用、剩余、总额、来源和异常状态。
- 内置 OpenAI / CLIProxyAPI、DeepSeek、PackyCode、窗口额度站和 API 健康检查适配。
- API Key 与 Base URL 能直接查询的供应商优先请求第三方官网接口。
- API Key 无法查询余额或遇到 WAF 时，由安装在日常 Edge/Chrome profile 中的余额伴侣执行同源请求。
- Cookie 继续保存在原浏览器，不复制到 Node，也不需要维护第二个 Edge profile。
- 获取失败不会自动打开第三方页面；只有手动点击“网页登录”才会激活原浏览器中的登录页。
- 打开 Hub 只读取缓存状态，不自动刷新供应商。
- v2 自己监听 `127.0.0.1:17891`，完全替代旧 Python 余额桥接。

v2 的余额数据流只有一个中心：

```text
Codex 余额条 ─┐
Hub 管理页面 ─┼→ v2 Balance Hub → 第三方官网 API / 现有浏览器回调
本机统一接口 ─┘
```

Hub 不执行、也不修改 CCSwitch 中已有的 `usage_script`。现阶段保留数据库原值；统一接口同时兼容已有的 `/usage/{alias}` 与 `/v1/balance/{alias}` 路径，方便后续逐个验证后再决定是否调整 CCSwitch 配置。

`v1` 分支继续维护不含 Balance Hub、内置 WAF 和网页登录修复的轻量版本；`main` 冻结，不作为开发分支。

本项目仅支持 Windows。开发与运行需要 Node.js 22 或更高版本；使用项目启动脚本时，Codex 会通过本地 CDP 调试端口与插件宿主连接。

- 不修改 `app.asar`、MSIX 或 Codex 配置。
- CCSwitch 数据库只读。
- Hub 只监听 `127.0.0.1:17891`。管理页面和写操作使用首次启动生成并保存在 `runtime` 的随机路径令牌。
- API Key、Cookie 与 Token 只在本机宿主内存中用于请求，不发送到 Hub 页面，也不写日志。
- WAF 查询通过 `browser-companion` 使用现有 Edge/Chrome profile 的登录状态；Cookie 原文不会回传。
- 不运行额外的 Codex 实例守护进程。
- 支持 `extra` 自由文本，以及 `used / remaining / total / unit` 结构。
- 随 CCSwitch 切换供应商自动更新；窗口变窄或缩放后按优先级折叠字段。

CCSwitch 原有自定义用量脚本的格式说明仍保留在 [USAGE_SCRIPT_FORMAT.md](./USAGE_SCRIPT_FORMAT.md)，但 v2 Hub 查询链路不执行这些脚本。

本机只读余额接口：

```text
GET /v1/health
GET /v1/providers
GET /v1/balance/{provider-id-or-alias}
GET /v1/balances
GET /usage/{provider-id-or-alias}
```

## 连接现有浏览器

AgentRouter、AnyRouter 等 WAF 站点需要一次性连接浏览器伴侣：

1. 在 `edge://extensions` 或 `chrome://extensions` 启用“开发人员模式”。
2. 选择“加载解压缩的扩展”，目录指向项目中的 `browser-companion`。
3. 打开 Balance Hub，点击“连接现有浏览器”复制连接码。
4. 点击“CCSwitch 余额伴侣”图标，粘贴连接码并保存。

伴侣扩展会监听当前浏览器的 Cookie/页面状态并通过同一个 `127.0.0.1:17891` 宿主回调。已有登录不会丢失；真正过期时才需要手动登录一次。

安装并启动：

```powershell
& .\scripts\install.ps1
& "$env:LOCALAPPDATA\CodexCCSwitchUsage\scripts\launch.ps1"
```

状态、停止和卸载：

```powershell
& "$env:LOCALAPPDATA\CodexCCSwitchUsage\scripts\status.ps1"
& "$env:LOCALAPPDATA\CodexCCSwitchUsage\scripts\stop.ps1"
& "$env:LOCALAPPDATA\CodexCCSwitchUsage\scripts\uninstall.ps1"
```

生成自带 Node 的 Windows 安装包：

```powershell
winget install --id JRSoftware.InnoSetup --exact --scope user
npm run build:exe
```

安装包输出到 `dist\CodexCCSwitchUsage-Setup-<version>.exe`。覆盖安装只替换程序文件并重启插件宿主，不会关闭 Codex，也不会删除 `runtime` 中的缓存和状态。

通过 EXE 安装的版本请从 Windows“已安装的应用”中卸载；`scripts\uninstall.ps1` 只用于原来的脚本安装方式。

每次安装、覆盖安装或版本升级都会无条件创建（或修复）开始菜单中的“Codex + CCSwitch 用量”快捷方式，确保 Windows 搜索能够找到它。桌面快捷方式仍由安装选项控制。插件使用 Codex 默认 profile；必须先从这个快捷方式启动，扩展才能连接本地调试接口。之后从系统通知、开始菜单或任务栏再次激活 Codex 时，会复用同一个实例。
