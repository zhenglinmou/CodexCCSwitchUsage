<!-- browser-companion-required:start -->
{{RELEASE_TRUST_NOTICE}}

## 浏览器伴侣

**何时需要：** 当 All API Hub 明确提示需要复用浏览器登录态、Cookie 或 WAF 查询时，必须安装浏览器伴侣；可直接通过 API 查询余额的供应商不需要它。

- `CCSwitch-Browser-Companion-{{COMPANION_VERSION}}.zip`：推荐给普通 Edge / Chrome 用户。解压后，在 `edge://extensions` 或 `chrome://extensions` 启用“开发人员模式”，点击“加载解压缩的扩展”，选择 `browser-companion` 文件夹。
- `CCSwitch-Browser-Companion-{{COMPANION_VERSION}}.crx`：同一私钥签名的 CRX3 包，适用于支持 CRX 导入或受管策略部署的环境。Chrome / Edge 对非商店来源的直接 CRX 安装可能仍会拦截；被拦截时使用 ZIP 的加载解压方式。

安装完成后，在 All API Hub 点击“连接现有浏览器”复制独立的伴侣连接码，打开伴侣扩展粘贴并保存，然后在扩展弹窗授予当前列出的站点权限。伴侣不会上传 Cookie 原文；有限 Key 遇到 WAF 时，受限同源请求的认证头只在伴侣内存中短暂使用，不会持久化。

## macOS 安装包

macOS 发布包按处理器架构分别提供：

- `{{MACOS_ARM64_FILENAME}}`：Apple Silicon。
- `{{MACOS_X64_FILENAME}}`：Intel Mac。

解压后打开 `CodexCCSwitchUsage-macOS-<架构>.app`。{{MACOS_PACKAGE_STATUS}} 使用前需先让 Codex 以随机的 `127.0.0.1` CDP 端口启动，伴侣启动器会从根进程参数自动发现端口。运行时状态写入 `~/Library/Application Support/CodexCCSwitchUsage/runtime`，不会写入 `/Applications` 内的 app bundle。

## 校验值

- 主安装器 SHA-256: `{{INSTALLER_SHA256}}`
- macOS Apple Silicon 包 SHA-256: `{{MACOS_ARM64_SHA256}}`
- macOS Intel 包 SHA-256: `{{MACOS_X64_SHA256}}`
- 浏览器伴侣 ZIP SHA-256: `{{COMPANION_ZIP_SHA256}}`
- 浏览器伴侣签名 CRX SHA-256: `{{COMPANION_CRX_SHA256}}`
<!-- browser-companion-required:end -->
