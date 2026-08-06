# Codex CCSwitch Usage

一个 Windows 本地扩展：读取 CCSwitch 的 Codex 供应商信息，并把用量嵌入 Codex 输入栏。当前以 v2 Balance Hub 为主。

## 先看效果

<p align="center">
  <img src="./docs/assets/balance-plugin/composer-desktop.png" alt="桌面端余额插件效果" width="900">
</p>

<table>
  <tr>
    <td><img src="./docs/assets/balance-plugin/composer-mobile.png" alt="移动端余额插件效果"></td>
    <td><img src="./docs/assets/balance-plugin/composer-refreshing.png" alt="余额刷新中效果"></td>
  </tr>
  <tr>
    <td><img src="./docs/assets/balance-plugin/recent-requests.png" alt="最近请求明细（已脱敏）"></td>
    <td><img src="./docs/assets/balance-plugin/hub-third-party-redacted.png" alt="第三方站点余额卡片（已脱敏）"></td>
  </tr>
</table>

完整图片索引见 [余额插件使用效果图](./docs/BALANCE_PLUGIN_SCREENSHOTS.md)。

## 选择版本

| 版本 | 分支 | 适用场景 | 用量来源 | All API Hub | 浏览器伴侣 |
|---|---|---|---|---|---|
| [v2.0.19](./docs/V2.md) | `v2` | 统一查看和管理全部 Codex / GPT 供应商 | v2 内置适配器与统一 Balance Hub | 支持 | 支持 |

- 使用 v2：阅读 [v2 用户文档](./docs/V2.md)；开发与热更新流程见 [v2 开发文档](./DEVELOPMENT.md)。
- 旧版基本弃用，仅保留历史兼容；资料见 [旧版文档](./docs/V1.md)。
- 隐私、安全边界与漏洞报告方式见 [隐私与安全政策](./SECURITY.md)。

## 分支策略

- `v2`：当前 Balance Hub 版本的维护分支。
- `main`：仓库默认分支，当前已快进到 v2 内容。

项目只支持 Windows，保持 CCSwitch 数据库只读，不修改 Codex 的 `app.asar`、MSIX 文件或 Codex 配置。
