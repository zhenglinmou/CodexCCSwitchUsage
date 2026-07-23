# Codex CCSwitch Usage

一个 Windows 本地扩展：读取 CCSwitch 的 Codex 供应商信息，并把用量嵌入 Codex 输入栏。项目同时维护 v1 和 v2 两条独立版本线，请按需要选择对应文档。

## 选择版本

| 版本 | 分支 | 适用场景 | 用量来源 | All API Hub | 浏览器伴侣 |
|---|---|---|---|---|---|
| [v2.0.8](./docs/V2.md) | `v2` | 统一查看和管理全部 Codex / GPT 供应商 | v2 内置适配器与统一 Balance Hub | 支持 | 支持 |
| [v1.0.0](./docs/V1.md) | `v1` | 只显示 CCSwitch 当前供应商余额的轻量版本 | 当前供应商已有的 `usage_script` | 不支持 | 不支持 |

- 使用 v2：阅读 [v2 用户文档](./docs/V2.md)；开发与热更新流程见 [v2 开发文档](./DEVELOPMENT.md)。
- 使用 v1：阅读 [v1 用户文档](./docs/V1.md)；自定义脚本格式见 [v1 `usage_script` 格式说明](./USAGE_SCRIPT_FORMAT.md)。

## 分支策略

- `v2`：当前 All API Hub / Balance Hub 版本的维护分支。
- `v1`：轻量版本的维护分支，也是仓库默认分支。
- `main`：冻结在 v1.0.0，不作为日常开发分支。

两个版本都只支持 Windows，保持 CCSwitch 数据库只读，不修改 Codex 的 `app.asar`、MSIX 文件或 Codex 配置。
