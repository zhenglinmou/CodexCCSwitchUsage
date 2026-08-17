## 重要：本版本的平台安装包未签名

本 Release 是维护者明确发布的未签名构建。Windows 安装器没有 Authenticode 签名，Microsoft Defender SmartScreen 可能显示“Windows 已保护你的电脑”；请先核对下方 SHA-256，只从本项目的 GitHub Release 下载，再决定是否选择“更多信息”继续安装。

macOS 安装包没有 Developer ID 签名，也未经过 Apple 公证，Gatekeeper 可能阻止首次打开；请先核对 SHA-256，再到“系统设置 → 隐私与安全性”确认来源并选择仍要打开。普通用户不需要配置 `CODEXCCSWITCH_SIGNING_THUMBPRINT`、`CODEXCCSWITCH_MACOS_SIGNING_IDENTITY` 或 `CODEXCCSWITCH_MACOS_NOTARY_PROFILE` 即可安装和使用本版本，这些变量只供维护者生成受信任签名包。
