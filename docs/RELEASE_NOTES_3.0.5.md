# v3.0.5

- 当前 OpenAI Official 卡片跟随 Codex 登录时，从本机 `auth.json` 读取当前登录并直查额度。CCSwitch 卡片里的旧 Token 不再触发选浏览器提示，显式绑定其他账号的卡片也不会被替换为本机账号。
- 最近请求弹层显示官方额度窗口和 Credits。Token 数继续来自 Codex 本机会话，能唯一匹配 CCSwitch 代理日志时显示实测总耗时和首字耗时。ChatGPT 订阅的请求行标为「订阅」，不显示估算扣费。
- 注入器升级到 97，浏览器伴侣保持 0.1.28。本机 Windows 安装包沿用未签名构建。
