# CCSwitch Balance Browser Companion

这个 MV3 伴侣扩展安装在用户日常使用的 Edge 或 Chrome profile 中，通过同一个 `127.0.0.1:17891` Balance Hub 接收查询任务并回调结果。

- 不保存或回传 Cookie 原文。
- 查询只使用当前浏览器已有的 Cookie 与同源页面环境。
- 没有现成站点标签页时，余额查询可短暂创建一个非活动同源标签页并在查询后立即关闭；不会自动激活登录页面。
- 只有用户在 Hub 中主动点击“网页登录”时才激活第三方站点。
- Hub 页面打开时不会自动刷新余额。
- 伴侣启动、重载或重连只恢复连接状态，不会自动查询余额；除 CCSwitch 当前供应商自身的配置化定时查询外，其余供应商均由用户手动刷新。
- Hub 连接码与固定 clientId 保存在当前浏览器的 `chrome.storage.local`。
- 首次保存连接码后，浏览器启动、后台闹钟唤醒以及每次 Hub 长轮询都会自动重新登记现有站点会话；成功验证过的站点只以 origin 提示保存在 `chrome.storage.local`，不保存 Cookie 或用户 ID。即使 Hub 快速热重启，平时也不需要打开伴侣弹窗。

开发阶段在 `edge://extensions` 或 `chrome://extensions` 中启用“开发人员模式”，选择“加载解压缩的扩展”，目录指向本文件所在的 `browser-companion` 文件夹。然后从 Hub 复制连接码，在扩展弹窗中保存一次。伴侣源码更新后只需在扩展管理页点击一次“重新加载”；连接码不会丢失。
