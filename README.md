# Codex CCSwitch Usage

一个轻量的本地扩展：读取 CCSwitch 的当前 Codex 供应商及 `usage_script`，把用量信息嵌入 Codex 输入栏底部的空白区域。

## v1.0.0 范围

首个源码版本只包含当前稳定功能：跟随 CCSwitch 当前 Codex 供应商，执行该供应商已有的 `usage_script`，并在 Codex 输入栏底部显示额度。多供应商 All API Hub 页面、内置 WAF 查询与网页登录修复不属于 v1.0.0。

本项目仅支持 Windows。开发与运行需要 Node.js 22 或更高版本；使用项目启动脚本时，Codex 会通过本地 CDP 调试端口与插件宿主连接。

- 不修改 `app.asar`、MSIX 或 Codex 配置。
- CCSwitch 数据库只读。
- 密钥只在本机内存中用于请求供应商自己的额度接口，不写日志。
- 不运行额外的 Codex 实例守护进程。
- 支持 `extra` 自由文本，以及 `used / remaining / total / unit` 结构。
- 随 CCSwitch 切换供应商自动更新；窗口变窄或缩放后按优先级折叠字段。

CCSwitch 自定义用量脚本的请求结构、`extractor` 返回 JSON 字段和兼容示例见 [USAGE_SCRIPT_FORMAT.md](./USAGE_SCRIPT_FORMAT.md)。

## v1 可选独立余额桥接器

此前单独保存在本机的 Python 余额桥接工程现已一并放入 v1 源码，目录为 [`balance-bridge`](./balance-bridge/README.md)。它为需要 API 适配、Cookie、OAuth 或 WAF 处理的供应商提供固定的 `http://127.0.0.1:17891/v1/balance/{provider-id}` 接口，再生成可粘贴进 CCSwitch 的 v1 `usage_script`。

桥接器是 v1 的可选独立进程，不是 Codex 插件宿主的一部分，也不会随 v1 EXE 自动启动。仓库只提供脱敏配置模板；本机 `providers.json`、provider UUID、API Key、Cookie、Token、日志和浏览器 profile 都不会提交。安装、配置、测试和启停方式见桥接器目录中的说明。

不要让这个 v1 Python 桥接器与 v2 Balance Hub 同时运行，因为二者都使用端口 `17891`。

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
