# Codex CCSwitch Usage

一个 Windows 本地扩展：把 CCSwitch 当前 Codex 供应商的用量嵌入 Codex 输入栏，并提供一个统一管理全部 Codex / GPT 供应商的 Balance Hub。

## v2.0.0 分支

`v2` 在保留原有余额条的基础上增加：

- 自动读取 CCSwitch 中全部 `app_type=codex` 供应商，不维护第二份账号清单。
- 点击余额文字打开本机 Balance Hub；窄窗口时可从额度弹层进入。
- 并发查询全部供应商，统一展示已用、剩余、总额、来源和异常状态。
- 内置 OpenAI / CLIProxyAPI、DeepSeek、PackyCode、窗口额度站和 API 健康检查适配。
- AnyRouter / AgentRouter 支持旧桥接迁移兜底，并提供 v2 专用持久化 Edge 网页会话。
- Cookie 或登录状态过期时，可在 Hub 中点击“网页登录”，登录后重新查询。

`v1` 分支继续维护不含 Balance Hub、内置 WAF 和网页登录修复的轻量版本；`main` 冻结，不作为开发分支。

本项目仅支持 Windows。开发与运行需要 Node.js 22 或更高版本；使用项目启动脚本时，Codex 会通过本地 CDP 调试端口与插件宿主连接。

- 不修改 `app.asar`、MSIX 或 Codex 配置。
- CCSwitch 数据库只读。
- Hub 只监听 `127.0.0.1`，页面和 API 使用每次启动随机生成的路径令牌。
- API Key、Cookie 与 Token 只在本机宿主内存中用于请求，不发送到 Hub 页面，也不写日志。
- 网页登录使用 `runtime\hub-edge-profile` 独立 Edge profile，不接管日常浏览器 profile。
- 不运行额外的 Codex 实例守护进程。
- 支持 `extra` 自由文本，以及 `used / remaining / total / unit` 结构。
- 随 CCSwitch 切换供应商自动更新；窗口变窄或缩放后按优先级折叠字段。

CCSwitch 自定义用量脚本的请求结构、`extractor` 返回 JSON 字段和兼容示例见 [USAGE_SCRIPT_FORMAT.md](./USAGE_SCRIPT_FORMAT.md)。

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
