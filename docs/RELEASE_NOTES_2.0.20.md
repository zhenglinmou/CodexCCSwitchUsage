# v2.0.20

## This Release

- 更新 Windows EXE 安装包，并保留覆盖安装时已有的运行时状态。
- 新增 Apple Silicon 与 Intel Mac 的独立 `.app` 压缩包；运行时状态写入用户目录，不修改应用包内容。
- 发布资产同时包含浏览器伴侣 ZIP 和签名 CRX，并为五个文件提供 SHA-256 校验值。
- v2 仍是当前维护版本；v1 仅保留历史兼容说明。

## Verification

- `npm test`: `384/384`
- Windows 静默覆盖安装：通过；Codex 根进程 PID `24264` 未变化，安装后宿主状态为运行中且已连接页面。
- macOS：已完成 arm64/x64 归档结构、应用目录和可执行权限静态校验；当前 Windows 环境未进行 Mac 实机 CDP 运行验证。
