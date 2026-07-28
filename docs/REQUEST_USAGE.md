# 逐请求用量接口

这是 v2 Balance Hub 的逐请求接口层。当前 Codex footer 的“最近请求”弹层在打开和手动刷新时调用本接口，展示当前供应商最新 10 条 Codex 调用。

查询策略是“官方或第三方真实记录优先，CCSwitch 本地估算兜底”：第三方逐请求日志可用时返回供应商真实 `quota` 和换算金额；OpenAI Official 从 Codex 官方本机会话事件返回准确 Token，但不虚构 ChatGPT 订阅不存在的单次扣费金额；其他来源不支持、鉴权失败、WAF/网络异常或返回无效数据时，自动返回 CCSwitch `proxy_request_logs` 中的最近请求。

## 调用方式

Hub 启动后，通过运行时目录中的 `hub-token` 访问受保护路径：

```text
POST http://127.0.0.1:17891/api/<hub-token>/request-usage
Content-Type: application/json

{"providerId":"<CCSwitch provider id>","limit":10}
```

`limit` 默认 10，允许范围为 1–50。接口只在本机 Hub token 路径下提供，不接受跨站 `/v1` 请求。

CCSwitch 本地回退固定查询 `app_type = 'codex'`。如果同一个 API Key 同时配置给 Codex 与 Claude/Claude Desktop，第三方记录会先按请求路径分类（`/v1/responses` / OpenAI 兼容路径属于 Codex，`/v1/messages` / Anthropic 路径属于 Claude），路径缺失时再使用模型族判断，然后才截取最新 10 条。共享 Key 中无法判定归属的远端记录不会混入 Codex 列表。

## 模板自动识别

All API Hub 自动识别逐请求模板时固定使用 `limit = 10`，只验证模板能力，不保存选择。识别结果会更新弹窗中的候选项，用户仍需点击“保存模板”才会写入绑定。

- `/api/log/token` 返回 HTTP 200 并不足以判定成功；响应必须包含 `success: true` 和数组形式的 `data`。
- 非空 `data` 必须至少包含一条带有效请求证据的 New API 活动日志：`type = 2` 消费行，或带模型、状态码、请求路径、扣费、Token/Token 数等字段的 `type = 5` 请求错误行。全 0 Token/费用的真实失败请求仍会保留；充值、签到、管理、纯系统事件、只有 `content` 的伪请求行，以及字段存在但值全部为空或 `null` 的占位行都会按 schema 错误拒绝。
- 空 Token 日志在没有待归属的近期本地成功请求时，只有 `/api/status` 同时返回可验证的 New API 计费结构才算模板可用，避免把任意空数组误判为逐请求接口。
- Token 日志为空或受 WAF/403 阻断时，可以尝试浏览器账户日志，但至少两条近期本地成功请求必须在时间、模型和输入/输出 Token 上逐条关联到同一远端 Token。优先使用 `token_id`；站点删掉该字段时，只返回实际关联成功的同名 `token_name` 行，不夹带其他同名记录。
- HTTP 401 或明确的无效 API Key 不会进入浏览器账户日志回退；无法证明当前 Key 归属时会失败关闭并交给 CCSwitch 本地记录兜底。
- 日志结构有效但 `/api/status` 计费配置不完整时，Token 记录仍可使用，但费用会标记为非精确和降级，不会伪装成供应商真实扣费。
- `record not found`、未通过归属校验、鉴权失败、网络错误或无效响应都会使远端模板识别失败；WAF 只有在上述严格账户日志关联成功时才可恢复，否则 Hub 随后测试 `CCSwitch 本地请求记录` 回退模板。

## 返回数据

成功查询时，`items` 是供应商最近的逐请求记录（按供应商时间倒序）：

```json
{
  "success": true,
  "providerId": "…",
  "source": "provider_log",
  "billing": {
    "available": true,
    "unit": "USD",
    "quotaPerUnit": 500000,
    "multiplier": 1
  },
  "items": [
    {
      "model": "gpt-5.6-sol",
      "inputTokens": 1234,
      "outputTokens": 56,
      "cacheReadTokens": 0,
      "cacheCreationTokens": 0,
      "rawQuota": 12345,
      "totalCost": 0.02469,
      "costUnit": "USD",
      "costExact": true,
      "costSource": "provider_log",
      "statusCode": 200,
      "recordType": "consume",
      "createdAt": "2026-07-25T00:00:00.000Z"
    }
  ]
}
```

`rawQuota` 是供应商日志原始扣费单位；`totalCost` 按供应商 `/api/status` 的计费配置换算，来源始终标记为 `provider_log`，不是 CCSwitch 本地估算。供应商的错误记录也会保留原始 `statusCode`；没有 usage 的记录不会被伪装成非零 Token。

远端不可用并回退 CCSwitch 时，顶层会返回：

```json
{
  "success": true,
  "source": "ccswitch_local",
  "remoteSource": "new-api-token-log",
  "fallback": true,
  "degraded": true,
  "preciseCostAvailable": false,
  "billing": {
    "exact": false,
    "unit": "USD",
    "multiplier": 1
  },
  "items": [
    {
      "totalCost": 0.0123,
      "costExact": false,
      "costSource": "ccswitch_local",
      "rawQuota": null
    }
  ]
}
```

此时 `totalCost` 是 CCSwitch 本地模型价格/倍率估算。第三方倍率与 CCSwitch 不一致时，它可能不等于账户实际扣费，因此必须同时检查 `fallback`、`preciseCostAvailable` 和每条记录的 `costExact`。

返回数据不会包含 API Key、Cookie、用户名、IP、Token 名称或请求正文。`requestId` / `upstreamRequestId` 仅在供应商公开返回时保留，供未来和 CCSwitch 日志做关联。

## 当前适配范围

### OpenAI Official

内置 `Codex 官方会话 Token` 模板只读取当前 Windows 用户下 `~/.codex/sessions/**/*.jsonl` 与 `~/.codex/archived_sessions/*.jsonl`。每个 `token_count` 增量记录会转换为一条请求，包含模型、输入、输出、缓存读取和推理 Token；累计值未增长的重复事件会忽略。ChatGPT 套餐没有公开逐请求货币扣费，因此 `totalCost` 保持 `null`、`preciseCostAvailable` 为 `false`，界面显示 `--`，不会显示 `$0`。

读取器先用 `session_meta.payload.model_provider` 排除自定义中转会话，再要求 CCSwitch OpenAI 供应商的账户 ID 与当前 `~/.codex/auth.json` 账户一致。账户不匹配时失败关闭并使用既有 CCSwitch 本地回退；返回结果不会包含会话消息、账户 ID、访问令牌或认证文件内容。

### New API 与其他第三方

以下站点具有内置 New API `/api/log/token` 尝试与回退配置。该清单表示 Hub 知道其安全 Origin 和查询方式，不表示远端接口在所有账号、地区或时刻都一定可用：

- AnyRouter（直连遇到 WAF 时通过已连接的浏览器伴侣请求同一个 API Key 接口）
- AgentRouter
- CHY 公益站
- freely
- 简直了
- 魔方公益站
- 君的公益（直连遇到 WAF 时通过已连接的浏览器伴侣请求同一个 API Key 接口；首次被 Cloudflare 拦截时需在官方页面完成一次验证）
- PackyCode
- 无名公益站

其他 CCSwitch 中转站可在 All API Hub 的“模板”弹窗中测试并选择 `New API 逐请求日志`。手动模板始终请求该供应商自己配置的安全 Origin，不会因显示名称把 API Key 转发到上述固定站点；远程 HTTP 只有在本机允许列表按供应商 ID 和精确 Origin 单独放行时才可直连，测试成功后仍需显式保存。

当前实测中，PackyCode 远端接口返回 `record not found`，会自动回退 CCSwitch 并明确标记为非精确；CHY 受地区限制或返回 403 时同样回退。君的公益直连受 WAF 或网站权限限制时可尝试浏览器伴侣，仍不可用才回退 CCSwitch。

`rawchat.cn` / `sharedchat.top` 的精确消费记录位于官网登录会话接口 `/frontend-api/vibe-code/records`，API Key 不能直接调用。当前遵循“不读取网页登录态”的约束，因此这两项直接走 CCSwitch 回退。

DeepSeek 官方当前没有按 API Key 查询历史逐请求日志的接口。CPA 调用统一接口时仍会返回 CCSwitch 本地记录，并标记为非精确。OpenAI Official 使用上文所述的 Codex 官方本机会话 Token。君的公益在浏览器伴侣不可用或远端接口失败时也会自动回退 CCSwitch。
