# 隐私与安全政策

Codex CCSwitch Usage 是一个仅在本机运行的 Windows/macOS 扩展。它读取 CCSwitch 的 Codex 供应商配置，在本机查询余额，并通过 Chrome DevTools Protocol 将结果显示在 Codex 中。项目不修改 Codex 或 CCSwitch 的安装文件和配置。

## 数据处理边界

- CCSwitch 数据库以只读方式打开，本项目不改写供应商、API Key 或 `usage_script`。
- API Key、账户 Token 和其他供应商认证信息通常只在本机宿主内存中用于访问用户配置的供应商接口，不发送到 Hub 页面，也不写入偏好、模板绑定或余额缓存。只有用户已配对浏览器伴侣且直连被 WAF 阻断时，宿主才会把固定白名单内的同源请求头（可能包含 `Authorization`）临时交给伴侣 Service Worker；这些值不写入浏览器存储、Hub 状态或日志。
- Balance Hub 只监听 `127.0.0.1:17891`。管理页面和写操作使用随机管理令牌；浏览器伴侣使用另一个独立配对密钥。伴侣协议 v3 对请求和响应执行 HMAC-SHA256 验证，并校验时间戳、随机数和响应绑定，旧的管理令牌式伴侣接口不再接受任务。
- 供应商默认必须使用 HTTPS。仅 CPA 的标准回环端口 `8317` 可隐式使用 HTTP；其他回环端口和内网 HTTP Origin 必须按供应商 ID 与精确 Origin 显式放行，防止供应商配置借宿主访问 Balance Hub、CDP 或其他本机服务。
- CDP 操作只连接经过校验的 Codex 主文档，不连接外部网页、Browser Use、MCP App 或辅助 WebView。
- OpenAI Official 的逐请求 Token 只从本机 `~/.codex/sessions` 与 `~/.codex/archived_sessions` 读取。读取器仅解析会话元数据、模型上下文和 `token_count` 事件，跳过对话正文；仅在供应商账户 ID 与当前 `~/.codex/auth.json` 账户一致时返回数据，并且不会向 Hub 暴露账户 ID、访问令牌或消息内容。
- 项目不包含产品遥测、分析 SDK 或云同步。除用户配置的供应商接口外，不主动上传用量、诊断或身份数据。

## 浏览器伴侣

浏览器伴侣只在用户明确配对和授权后工作。它按当前供应商模板申请精确的 HTTPS 站点权限，复用用户现有 Edge 或 Chrome profile 的登录状态。公司内部 HTTP 供应商只能通过本机配置按供应商 ID 和精确 Origin 单独允许，并且只由 Node 宿主直连，不会扩展浏览器伴侣的站点权限。

Cookie 原文始终保留在浏览器中。伴侣的本机存储仅包含配对令牌、浏览器实例标识、已授权 Origin、协议状态，以及部分 New API 站点请求所需的数字用户 ID；不保存 Cookie、API Key、Bearer Token 或网页 localStorage 原文。

伴侣任务只允许 `query-json` 和 `open-login`，目标必须是当前模板给出的同一 HTTPS Origin，请求头也限制在固定集合。有限 Key 的 WAF 回退可能让完整认证头在伴侣内存中短暂存在；账号归属探测仍优先使用站点返回的脱敏 Key 标识。安装伴侣等同于信任该扩展在用户明确授权的站点上执行这些受限请求。

## CDP 边界

CDP 本身不提供应用层认证。新启动的 Windows Codex 默认使用随机可用端口并显式绑定 `127.0.0.1`；macOS 启动器自动发现随机回环端口。启动器拒绝显式绑定外部网卡的调试进程，并将实际端口保存在仅当前用户可读的 `runtime/cdp-port`。现有安全回环会话可以继续复用其原端口，因此升级不会为迁移端口而重启 Codex。

这些措施降低网页和局域网访问面，但不能隔离同一操作系统账号下的恶意本机进程：同用户进程仍可能枚举进程参数或访问回环端口。该限制来自 Electron/Chromium CDP；对本机账号已失陷的场景，本项目不声称提供进程级安全隔离。

## 本机留存

`runtime` 目录可能包含：

- 余额和查询状态缓存，以及不含凭据的配置指纹；
- OpenAI 官方会话逐请求用量的有界派生索引；该索引不含对话正文、访问令牌或请求正文；
- 收藏、排序、已忽略供应商、浏览器显示别名等界面偏好；
- 供应商 ID、配置 Origin 和模板 ID 组成的模板绑定；
- Hub 随机路径令牌、进程状态和运行诊断。

Windows 使用当前用户专有 ACL，macOS/Linux 使用 `0700` 目录和 `0600` 文件保存上述状态。正式 Windows Release 要求 Authenticode 签名，正式 macOS Release 要求 Developer ID 签名、公证与 stapling，并用 `ditto` ZIP 保留签名元数据和公证票据；构建脚本只有在显式 `AllowUnsigned` 时才允许生成私人测试包，发布脚本拒绝这类未签名产物。

安装升级会保留 `runtime`，正常卸载会移除已安装版本的该目录。开发工作区与稳定安装使用各自独立的 `runtime`。

## 诊断报告

“复制脱敏报告”只在用户主动点击时把报告写入本机剪贴板，不会自动上传。报告可能包含应用版本、运行状态、供应商名称与 ID、查询状态和时间、浏览器显示名称及已验证站点 Origin，但不包含 API Key、Cookie、Bearer Token 或请求正文。分享前仍应检查其中的供应商名称和站点信息是否适合公开。

## 报告安全问题

请优先通过 GitHub 仓库的私密 Security Advisory 报告漏洞。若私密报告入口不可用，可先提交一个不含敏感细节的 Issue，请求维护者建立私密沟通渠道。

不要在公开 Issue、日志或截图中提交 API Key、Cookie、Token、完整 CCSwitch 数据库或完整 `runtime` 目录。报告应包含受影响版本、复现条件、预期影响和最小化的脱敏证据。
