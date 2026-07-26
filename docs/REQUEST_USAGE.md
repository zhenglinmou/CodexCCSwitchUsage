# 第三方逐请求用量接口

这是 v2 Balance Hub 的逐请求接口层。当前 Codex footer 的“最近请求”弹层在打开和手动刷新时调用本接口，展示当前供应商最新 10 条 Codex 调用。

查询策略是“第三方真实扣费优先，CCSwitch 本地估算兜底”：第三方逐请求日志可用时返回供应商真实 `quota` 和换算金额；第三方不支持、鉴权失败、WAF/网络异常或返回无效数据时，自动返回 CCSwitch `proxy_request_logs` 中的最近请求。

## 调用方式

Hub 启动后，通过运行时目录中的 `hub-token` 访问受保护路径：

```text
POST http://127.0.0.1:17891/api/<hub-token>/request-usage
Content-Type: application/json

{"providerId":"<CCSwitch provider id>","limit":10}
```

`limit` 默认 10，允许范围为 1–50。接口只在本机 Hub token 路径下提供，不接受跨站 `/v1` 请求。

CCSwitch 本地回退固定查询 `app_type = 'codex'`。如果同一个 API Key 同时配置给 Codex 与 Claude/Claude Desktop，第三方记录会先按请求路径分类（`/v1/responses` / OpenAI 兼容路径属于 Codex，`/v1/messages` / Anthropic 路径属于 Claude），路径缺失时再使用模型族判断，然后才截取最新 10 条。共享 Key 中无法判定归属的远端记录不会混入 Codex 列表。

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

已确认提供 New API 兼容 `/api/log/token` 的站点：

- AnyRouter（直连遇到 WAF 时通过已连接的浏览器伴侣请求同一个 API Key 接口）
- AgentRouter
- CHY 公益站
- freely
- 简直了
- 魔方公益站
- 君的公益（直连遇到 WAF 时通过已连接的浏览器伴侣请求同一个 API Key 接口；首次被 Cloudflare 拦截时需在官方页面完成一次验证）
- PackyCode
- 无名公益站

其他 CCSwitch 中转站可在 All API Hub 的“模板”弹窗中测试并选择 `New API 逐请求日志`。手动模板始终请求该供应商自己配置的 HTTPS Origin，不会因显示名称把 API Key 转发到上述固定站点；测试成功后仍需显式保存。

其中 PackyCode 当前远端接口返回 `record not found` 时会自动回退 CCSwitch，并明确标记为非精确。CHY 当前若受地区限制，同样回退 CCSwitch。

`rawchat.cn` / `sharedchat.top` 的精确消费记录位于官网登录会话接口 `/frontend-api/vibe-code/records`，API Key 不能直接调用。当前遵循“不读取网页登录态”的约束，因此这两项直接走 CCSwitch 回退。

DeepSeek 官方当前没有按 API Key 查询历史逐请求日志的接口。CPA 和 OpenAI 官方登录按当前任务范围不查询第三方日志；调用统一接口时仍会返回 CCSwitch 本地记录，并标记为非精确。君的公益在浏览器伴侣不可用或远端接口失败时也会自动回退 CCSwitch。
