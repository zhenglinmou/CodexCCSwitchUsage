# v2 CCSwitch Balance Browser Companion

> 此浏览器伴侣仅属于 v2。v1 不包含 All API Hub、WAF 同源查询或浏览器伴侣；版本差异见 [docs/V1.md](../docs/V1.md) 与 [docs/V2.md](../docs/V2.md)。

这个 MV3 伴侣扩展安装在用户日常使用的 Edge 或 Chrome profile 中，通过同一个 `127.0.0.1:17891` Balance Hub 接收查询任务并回调结果。

- 不保存或回传 Cookie 原文。
- 查询只使用当前浏览器已有的 Cookie 与同源页面环境。
- 余额查询本身不会创建、激活或聚焦第三方标签页。
- 只有用户在 Hub 中主动点击“同步现有会话”或“去官网认证”时，才会复用现有页面或激活第三方官网登录页。
- Hub 页面打开时不会自动刷新余额。
- 伴侣启动、重载或重连只恢复连接状态，不会自动查询余额；只有 CCSwitch 当前供应商固定每五分钟查询，其余供应商均由用户手动刷新。
- Hub 连接码与固定 clientId 保存在当前浏览器的 `chrome.storage.local`。
- 首次保存连接码后，浏览器启动、后台闹钟唤醒或 Hub 重连时会登记一次现有站点会话；后续长轮询只等待显式任务，不重复读取 Cookie。每轮复用同一份连接配置，相同状态与会话值不重复写入，短时间内连续出现的 Cookie/标签页事件只合并成一次心跳。`chrome.storage.local` 保存已验证 origin 和 New API 所需的纯数字用户 ID，不保存 Cookie、Token 或 localStorage 原文。即使 Hub 快速热重启，平时也不需要打开伴侣弹窗。

开发阶段在 `edge://extensions` 或 `chrome://extensions` 中启用“开发人员模式”，选择“加载解压缩的扩展”，目录指向本文件所在的 `browser-companion` 文件夹。然后从 Hub 复制连接码，在扩展弹窗中保存一次。伴侣源码更新后只需在扩展管理页点击一次“重新加载”；连接码不会丢失。
