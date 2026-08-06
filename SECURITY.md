# 隐私与安全政策

Codex CCSwitch Usage 是一个仅在本机运行的 Windows/macOS 扩展。它读取 CCSwitch 的 Codex 供应商配置，在本机查询余额，并通过 Chrome DevTools Protocol 将结果显示在 Codex 中。项目不修改 Codex 或 CCSwitch 的安装文件和配置。

## 数据处理边界

- CCSwitch 数据库以只读方式打开，本项目不改写供应商、API Key 或 `usage_script`。
- API Key、账户 Token 和其他供应商认证信息只在本机宿主内存中用于访问用户配置的供应商接口，不发送到 Hub 页面，也不写入本项目的偏好、模板绑定或余额缓存。
- Balance Hub 只监听 `127.0.0.1:17891`。页面和写操作使用首次运行时生成的随机路径令牌，并拒绝跨站浏览器请求。
- CDP 操作只连接经过校验的 Codex 主文档，不连接外部网页、Browser Use、MCP App 或辅助 WebView。
- OpenAI Official 的逐请求 Token 只从本机 `~/.codex/sessions` 与 `~/.codex/archived_sessions` 读取。读取器仅解析会话元数据、模型上下文和 `token_count` 事件，跳过对话正文；仅在供应商账户 ID 与当前 `~/.codex/auth.json` 账户一致时返回数据，并且不会向 Hub 暴露账户 ID、访问令牌或消息内容。
- 项目不包含产品遥测、分析 SDK 或云同步。除用户配置的供应商接口外，不主动上传用量、诊断或身份数据。

## 浏览器伴侣

浏览器伴侣只在用户明确配对和授权后工作。它按当前供应商模板申请精确的 HTTPS 站点权限，复用用户现有 Edge 或 Chrome profile 的登录状态。公司内部 HTTP 供应商只能通过本机配置按供应商 ID 和精确 Origin 单独允许，并且只由 Node 宿主直连，不会扩展浏览器伴侣的站点权限。

Cookie 原文始终保留在浏览器中。伴侣的本机存储仅包含配对令牌、浏览器实例标识、已授权 Origin、协议状态，以及部分 New API 站点请求所需的数字用户 ID；不保存 Cookie、API Key、Bearer Token 或网页 localStorage 原文。

## 本机留存

`runtime` 目录可能包含：

- 余额和查询状态缓存，以及不含凭据的配置指纹；
- OpenAI 官方会话逐请求用量的有界派生索引；该索引不含对话正文、访问令牌或请求正文；
- 收藏、排序、已忽略供应商、浏览器显示别名等界面偏好；
- 供应商 ID、配置 Origin 和模板 ID 组成的模板绑定；
- Hub 随机路径令牌、进程状态和运行诊断。

安装升级会保留 `runtime`，正常卸载会移除已安装版本的该目录。开发工作区与稳定安装使用各自独立的 `runtime`。

## 诊断报告

“复制脱敏报告”只在用户主动点击时把报告写入本机剪贴板，不会自动上传。报告可能包含应用版本、运行状态、供应商名称与 ID、查询状态和时间、浏览器显示名称及已验证站点 Origin，但不包含 API Key、Cookie、Bearer Token 或请求正文。分享前仍应检查其中的供应商名称和站点信息是否适合公开。

## 报告安全问题

请优先通过 GitHub 仓库的私密 Security Advisory 报告漏洞。若私密报告入口不可用，可先提交一个不含敏感细节的 Issue，请求维护者建立私密沟通渠道。

不要在公开 Issue、日志或截图中提交 API Key、Cookie、Token、完整 CCSwitch 数据库或完整 `runtime` 目录。报告应包含受影响版本、复现条件、预期影响和最小化的脱敏证据。
