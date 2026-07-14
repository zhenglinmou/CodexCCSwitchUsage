# CCSwitch Balance Browser Companion

这个 MV3 伴侣扩展安装在用户日常使用的 Edge 或 Chrome profile 中，通过同一个 `127.0.0.1:17891` Balance Hub 接收查询任务并回调结果。

- 不保存或回传 Cookie 原文。
- 查询只使用当前浏览器已有的 Cookie 与同源页面环境。
- 查询失败不会自动打开登录页面。
- 只有用户在 Hub 中主动点击“网页登录”时才激活第三方站点。
- Hub 页面打开时不会自动刷新余额。

开发阶段在 `edge://extensions` 或 `chrome://extensions` 中启用“开发人员模式”，选择“加载解压缩的扩展”，目录指向本文件所在的 `browser-companion` 文件夹。然后从 Hub 复制连接码，在扩展弹窗中保存一次。
