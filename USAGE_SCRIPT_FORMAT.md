# CCSwitch `usage_script` 返回格式说明

> 本文是 v1 脚本兼容文档。v2 Balance Hub 不执行 CCSwitch 中的 `usage_script`；v2 的数据流和内置适配器说明见 [docs/V2.md](./docs/V2.md)。

本文说明 CCSwitch 自定义用量查询脚本应如何编写，以及 CodexCCSwitchUsage 实际接受什么样的返回数据。

核对依据：

- [CCSwitch 官方用量查询文档](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/zh/2-providers/2.5-usage-query.md)
- [CCSwitch 官方 `usage_script` 执行与校验源码](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/usage_script.rs)
- 本项目 `src/usage-client.mjs` 和 `src/evaluator-worker.mjs`

> 核心结论：额度接口本身不需要返回 CCSwitch 规定的固定 JSON。接口可以返回供应商自己的任意 JSON；真正需要遵守统一格式的是 `extractor(response)` 的返回值。

## 1. 完整脚本结构

CCSwitch 的 `usage_script.code` 是一个 JavaScript 表达式，运行后必须得到包含 `request` 和 `extractor` 的对象：

```javascript
({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Content-Type": "application/json"
    }
  },

  extractor: function (response) {
    return {
      planName: "默认套餐",
      used: Number(response.data.used),
      remaining: Number(response.data.remaining),
      total: Number(response.data.total),
      unit: "USD"
    };
  }
})
```

处理流程是：

1. CCSwitch 替换脚本中的占位符。
2. 按 `request` 请求额度接口。
3. 把接口响应解析为 JSON，并作为 `response` 传给 `extractor(response)`。
4. `extractor` 把供应商自己的响应结构转换成统一用量对象。
5. CodexCCSwitchUsage 读取同一份脚本，并把转换后的结果显示在 Codex 输入框下方。

## 2. `request` 格式

```json
{
  "url": "https://api.example.com/user/balance",
  "method": "GET",
  "headers": {
    "Authorization": "Bearer token"
  },
  "body": "{\"query\":\"balance\"}"
}
```

| 字段 | 类型 | 要求 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 完整请求地址。CodexCCSwitchUsage 对非本机地址要求 HTTPS。 |
| `method` | string | 建议填写 | 如 `GET`、`POST`；CodexCCSwitchUsage 未填写时默认为 `GET`。 |
| `headers` | object | 可选 | 请求头键值对。 |
| `body` | string 或 object | 可选 | CCSwitch 官方结构定义为字符串；本扩展还会自动把对象序列化为 JSON。为兼容两边，建议显式写成字符串。 |

可用占位符：

| 占位符 | 内容 |
|---|---|
| `{{apiKey}}` | 用量配置中的 API Key；未单独填写时通常回退到供应商 API Key。 |
| `{{baseUrl}}` | 用量配置中的 Base URL；未单独填写时通常回退到供应商 Base URL。 |
| `{{accessToken}}` | Access Token，常用于 New API。 |
| `{{userId}}` | User ID，常用于 New API。 |

不要在脚本里公开真实密钥，也不要把密钥写入 `extractor` 返回值、错误信息或日志。

## 3. `extractor` 返回 JSON

### 推荐格式

为了同时兼容 CCSwitch 和当前 CodexCCSwitchUsage，推荐返回一个对象，并至少包含 `remaining`、`used`、`total` 或非空 `extra` 中的一项：

```json
{
  "isValid": true,
  "planName": "Pro",
  "used": 25.5,
  "remaining": 74.5,
  "total": 100,
  "unit": "USD",
  "extra": "本月额度"
}
```

字段说明：

| 字段 | 类型 | 是否必填 | 含义 |
|---|---|---|---|
| `isValid` | boolean | 否 | 是否为有效数据。省略时按有效处理；`false` 会显示查询失败。 |
| `invalidMessage` | string | 否 | `isValid: false` 时的错误说明。 |
| `planName` | string | 否 | 套餐名称；本扩展会用它替代供应商名称。 |
| `used` | number | 否 | 已使用额度。 |
| `remaining` | number | 否 | 剩余额度。 |
| `total` | number | 否 | 总额度。 |
| `unit` | string | 否 | 单位，例如 `USD`、`CNY`、`tokens`、`次`。 |
| `extra` | string | 否 | 自由展示文本，例如到期日或额度说明。 |

数值字段最好直接返回 JSON number，不要返回带货币符号、逗号或单位的字符串。例如返回 `1234.5`，不要返回 `"$1,234.5"`。本扩展虽然会接受可转换成有限数字的字符串，但 CCSwitch 官方校验要求这些字段是 number 或 `null`。

### 本扩展额外支持的字段

以下字段不是 CCSwitch 官方 `UsageData` 字段，但 CodexCCSwitchUsage 会识别：

| 字段 | 类型 | 含义 |
|---|---|---|
| `periodLabel` | string | 周期标签，例如 `本月`，显示为“本月已用”。 |
| `hideTotal` | boolean | 设为 `true` 时不显示总额。 |

如果脚本还要在 CCSwitch 自身界面中使用，可以返回这两个额外字段；CCSwitch 当前的字段校验不会因额外键而失败，但它自身不会展示这两个字段。

## 4. 常用返回示例

### 只显示余额

```javascript
extractor: function (response) {
  return {
    remaining: response.balance,
    unit: "USD"
  };
}
```

### 显示已用、剩余和总额

```javascript
extractor: function (response) {
  const total = Number(response.data.limit);
  const used = Number(response.data.used);

  return {
    planName: response.data.plan || "默认套餐",
    used: used,
    remaining: total - used,
    total: total,
    unit: "USD"
  };
}
```

### 接口返回失败

```javascript
extractor: function (response) {
  if (!response.success || !response.data) {
    return {
      isValid: false,
      invalidMessage: response.message || "额度查询失败"
    };
  }

  return {
    remaining: response.data.balance,
    unit: "USD"
  };
}
```

### New API 示例

```javascript
({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "New-Api-User": "{{userId}}"
    }
  },
  extractor: function (response) {
    if (response.success && response.data) {
      return {
        planName: response.data.group || "默认套餐",
        remaining: response.data.quota / 500000,
        used: response.data.used_quota / 500000,
        total: (response.data.quota + response.data.used_quota) / 500000,
        unit: "USD"
      };
    }

    return {
      isValid: false,
      invalidMessage: response.message || "查询失败"
    };
  }
})
```

## 5. CCSwitch 与本扩展的兼容差异

| 能力 | CCSwitch 官方 | 当前 CodexCCSwitchUsage |
|---|---|---|
| 单个用量对象 | 支持 | 支持，推荐使用 |
| 多套餐对象数组 | 支持非空数组 | 暂不支持，会被判定为没有可显示字段 |
| `periodLabel` / `hideTotal` | 不展示 | 支持 |
| 数字字符串 | 官方校验不接受 | 可转换为有限数字时接受 |
| `extra` 单独展示 | 支持 | 支持，且允许只返回非空 `extra` |

因此，要让同一份脚本稳定用于两边，请遵循以下最小兼容规则：

1. `extractor` 返回单个普通对象，不返回数组。
2. `used`、`remaining`、`total` 返回真正的数字或 `null`。
3. 至少提供一个可展示字段；推荐始终提供 `remaining`。
4. 错误时返回 `{ isValid: false, invalidMessage: "..." }`。
5. 保证额度接口响应是合法 JSON，且响应体不要过大；本扩展上限为 2 MB。

## 6. 常见错误

- 直接让接口返回统一对象，但 `extractor` 忘记 `return`。
- 返回 `"10 USD"`、`"1,000"` 等无法可靠计算的数值字符串。
- `isValid` 写成字符串 `"false"`，而不是布尔值 `false`。
- 把 CCSwitch 的外层调用结果 `{ success, data, error }` 当成 `extractor` 应返回的格式。`extractor` 应返回的是 `data` 中的单个用量对象。
- 返回多套餐数组；CCSwitch 能显示，但当前 CodexCCSwitchUsage 不能显示。
- 请求地址不是 JSON 接口，返回 HTML、纯文本或登录页。
