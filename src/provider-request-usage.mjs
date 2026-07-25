import { fetchJson, parseBrowserJson, providerKind } from './hub-provider-adapters.mjs';

export const DEFAULT_REQUEST_USAGE_LIMIT = 10;
export const MAX_REQUEST_USAGE_LIMIT = 50;

const DEFAULT_QUOTA_PER_UNIT = 500_000;
const REQUEST_USAGE_TIMEOUT_MS = 45_000;
const REQUEST_USAGE_ATTEMPTS = 2;

const EXCLUDED_PROVIDER_KINDS = new Set(['openai', 'cpa']);
const NEW_API_LOG_ADAPTERS = Object.freeze([
  {
    id: 'anyrouter',
    label: 'AnyRouter',
    domains: ['anyrouter.top', 'a-ocnfniawgw.cn-shanghai.fcapp.run'],
    origin: 'https://anyrouter.top',
    browserFallback: true,
  },
  { id: 'agentrouter', label: 'AgentRouter', domains: ['agentrouter.org'] },
  { id: 'chy', label: 'CHY 公益站', domains: ['chybenzun.top'] },
  { id: 'freely', label: 'freely', domains: ['free.lyclaude.site'] },
  { id: 'jianzhile', label: '简直了', domains: ['jianzhile.vip'] },
  { id: 'mofa', label: '魔方公益站', domains: ['mofas.one'] },
  { id: 'muyuan', label: '君的公益', domains: ['muyuan.do'], browserFallback: true },
  { id: 'packy', label: 'PackyCode', domains: ['packyapi.com'] },
  { id: 'welfare', label: '无名公益站', domains: ['welfare.0xpsyche.me'] },
]);

const RECORD_TYPE_NAMES = Object.freeze({
  0: 'unknown',
  1: 'topup',
  2: 'consume',
  3: 'manage',
  4: 'system',
  5: 'error',
  6: 'refund',
  7: 'login',
});

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback = null) {
  const number = finiteNumber(value, fallback);
  return number != null && number > 0 ? number : fallback;
}

function integerOrNull(value) {
  const number = finiteNumber(value);
  return number != null && Number.isSafeInteger(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = integerOrNull(value);
  return number != null && number >= 0 ? number : 0;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value, 0);
  return number != null && number >= 0 ? number : 0;
}

function cleanText(value, maximum = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function configuredOrigin(provider) {
  const value = String(provider?.apiBaseUrl || provider?.baseUrl || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:') return null;
    return { origin: url.origin, hostname };
  } catch {
    return null;
  }
}

function redactedMessage(value, secrets = []) {
  let message = cleanText(value, 240)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(sk-|api[_-]?key|token|secret|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
  for (const secret of secrets) {
    const valueToRedact = String(secret || '');
    if (valueToRedact.length >= 4) message = message.split(valueToRedact).join('[redacted]');
  }
  return message;
}

function providerBackend(provider) {
  const kind = providerKind(provider);
  if (EXCLUDED_PROVIDER_KINDS.has(kind)) {
    return {
      supported: false,
      adapter: 'excluded',
      reason: '当前阶段暂不查询这个供应商的第三方逐请求用量',
    };
  }
  if (kind === 'deepseek') {
    return {
      supported: false,
      adapter: 'response-usage-only',
      reason: 'DeepSeek 官方没有按 API Key 查询历史逐请求用量的接口；只能在模型响应中读取 usage',
    };
  }
  if (kind === 'paid') {
    return {
      supported: false,
      adapter: 'website-session-only',
      reason: '付费站真实消费记录只提供官网登录会话接口；当前不读取网页登录态，改用 CCSwitch 本地记录',
    };
  }

  const configured = configuredOrigin(provider);
  if (!configured) {
    return {
      supported: false,
      adapter: 'unconfigured',
      reason: '供应商没有可安全查询的 HTTPS Base URL',
    };
  }
  const adapter = NEW_API_LOG_ADAPTERS.find(item => item.domains.some(domain => hostnameMatches(configured.hostname, domain)));
  if (!adapter) {
    return {
      supported: false,
      adapter: 'unknown',
      reason: '尚未确认该供应商提供按 API Key 查询的逐请求用量接口',
    };
  }
  return {
    supported: true,
    adapter: 'new-api-token-log',
    adapterId: adapter.id,
    label: adapter.label,
    logPath: '/api/log/token',
    statusPath: '/api/status',
    origin: adapter.origin || configured.origin,
    hostname: configured.hostname,
    browserFallback: adapter.browserFallback === true,
  };
}

export function normalizeRequestUsageLimit(value = DEFAULT_REQUEST_USAGE_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_USAGE_LIMIT;
  return Math.max(1, Math.min(MAX_REQUEST_USAGE_LIMIT, Math.trunc(parsed)));
}

export function describeProviderRequestUsage(provider) {
  const backend = providerBackend(provider);
  const common = {
    supported: backend.supported === true,
    adapter: backend.adapter,
    providerAdapter: backend.adapterId || '',
    method: backend.supported ? 'GET' : '',
    requestUrl: backend.supported ? `${backend.origin}${backend.logPath}` : '',
    configurationUrl: backend.supported ? `${backend.origin}${backend.statusPath}` : '',
    authentication: backend.supported ? 'Bearer API Key' : '',
    executor: backend.supported
      ? (backend.browserFallback ? 'Balance Hub 直接请求；遇到 WAF 时通过浏览器伴侣转发' : 'Balance Hub 直接请求第三方接口')
      : '',
    notes: [],
  };
  if (!backend.supported) {
    return { ...common, reason: backend.reason };
  }
  return {
    ...common,
    label: `${backend.label}逐请求用量日志`,
    notes: [
      '只读取供应商返回的逐请求日志，不使用 CCSwitch 本地费用估算',
      '计费金额由供应商日志 quota 和站点 /api/status 计费配置换算',
      'API Key 只放在 Balance Hub 到供应商的内存请求中，不会进入返回数据',
      ...(backend.browserFallback ? ['直接请求被 WAF 拦截时，允许通过已连接的浏览器伴侣读取同一 API Key 接口'] : []),
    ],
  };
}

function parseNewApiDisplayPayload(payload, providerLabel) {
  const root = payload && typeof payload === 'object' ? payload : null;
  const data = root?.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : null;
  if (root?.success !== true || !data) {
    throw new Error(redactedMessage(root?.message || `${providerLabel}站点配置响应无效`));
  }

  const displayType = String(data.quota_display_type || '').trim().toUpperCase();
  if (!displayType) {
    // Older New API installations only expose display_in_currency.
    const quotaPerUnit = positiveNumber(data.quota_per_unit, DEFAULT_QUOTA_PER_UNIT);
    if (data.display_in_currency === false) {
      return {
        displayType: 'TOKENS',
        quotaPerUnit,
        multiplier: 1,
        unit: 'quota',
        exact: false,
        legacy: true,
      };
    }
    return {
      displayType: 'USD',
      quotaPerUnit,
      multiplier: 1,
      unit: 'USD',
      exact: true,
      legacy: true,
    };
  }
  if (!['USD', 'CNY', 'CUSTOM', 'TOKENS'].includes(displayType)) {
    throw new Error(`${providerLabel}站点配置中的 quota_display_type 无效`);
  }
  if (displayType === 'TOKENS') {
    return { displayType, quotaPerUnit: 1, multiplier: 1, unit: 'tokens', exact: true, legacy: false };
  }
  const quotaPerUnit = positiveNumber(data.quota_per_unit);
  if (quotaPerUnit == null) throw new Error(`${providerLabel}站点配置中的 quota_per_unit 无效`);
  if (displayType === 'CNY') {
    const multiplier = positiveNumber(data.usd_exchange_rate);
    if (multiplier == null) throw new Error(`${providerLabel}站点配置中的 usd_exchange_rate 无效`);
    return { displayType, quotaPerUnit, multiplier, unit: 'CNY', exact: true, legacy: false };
  }
  if (displayType === 'CUSTOM') {
    const multiplier = positiveNumber(data.custom_currency_exchange_rate);
    if (multiplier == null) throw new Error(`${providerLabel}站点配置中的 custom_currency_exchange_rate 无效`);
    return {
      displayType,
      quotaPerUnit,
      multiplier,
      unit: cleanText(data.custom_currency_symbol, 16) || 'custom',
      exact: true,
      legacy: false,
    };
  }
  return { displayType, quotaPerUnit, multiplier: 1, unit: 'USD', exact: true, legacy: false };
}

function convertQuota(rawQuota, display) {
  if (rawQuota == null || !display || !display.exact) return null;
  const amount = rawQuota / display.quotaPerUnit * display.multiplier;
  return Number.isFinite(amount) ? Number(amount.toFixed(12)) : null;
}

function parseOther(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstNumber(object, keys, fallback = null) {
  for (const key of keys) {
    const value = finiteNumber(object?.[key]);
    if (value != null) return value;
  }
  return fallback;
}

function parseCreatedAt(value) {
  const epoch = finiteNumber(value);
  if (epoch == null || epoch <= 0) return '';
  const milliseconds = epoch > 1_000_000_000_000 ? epoch : epoch * 1_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function parseCacheCreationTokens(other) {
  const direct = firstNumber(other, ['cache_write_tokens', 'cache_creation_tokens']);
  if (direct != null) return nonNegativeInteger(direct);
  return nonNegativeInteger(
    firstNumber(other, ['cache_creation_tokens_5m'], 0)
      + firstNumber(other, ['cache_creation_tokens_1h'], 0),
  );
}

export function classifyProviderRequestLogApp(row) {
  const source = row && typeof row === 'object' ? row : {};
  const other = parseOther(source.other);
  const requestPath = cleanText(
    other.request_path || other.path || source.request_path || source.path,
    240,
  ).toLowerCase();
  if (/(?:^|\/)v1\/messages(?:[/?]|$)|(?:^|\/)messages(?:[/?]|$)|\/anthropic(?:[/?]|$)/.test(requestPath)) {
    return 'claude';
  }
  if (/(?:^|\/)v1\/responses(?:[/?]|$)|(?:^|\/)responses(?:[/?]|$)|\/chat\/completions(?:[/?]|$)/.test(requestPath)) {
    return 'codex';
  }

  const model = cleanText(source.model_name || source.model, 160).toLowerCase();
  if (/^claude(?:[-_.]|$)/.test(model)) return 'claude';
  if (/^(?:gpt|chatgpt|codex)(?:[-_.]|$)|^o[134](?:[-_.]|$)/.test(model)) return 'codex';
  return '';
}

export function parseProviderRequestLog(row, display = null) {
  const source = row && typeof row === 'object' ? row : {};
  const other = parseOther(source.other);
  const type = nonNegativeInteger(source.type);
  const inputTokens = nonNegativeInteger(source.prompt_tokens);
  const outputTokens = nonNegativeInteger(source.completion_tokens);
  const cacheReadTokens = nonNegativeInteger(firstNumber(other, ['cache_tokens', 'cached_tokens', 'cache_read_tokens'], 0));
  const cacheCreationTokens = parseCacheCreationTokens(other);
  const rawQuota = finiteNumber(source.quota);
  const statusCode = integerOrNull(firstNumber(other, ['status_code', 'http_status', 'error_code']))
    ?? (type === 2 ? 200 : null);
  const durationSeconds = nonNegativeNumber(source.use_time);
  const firstTokenMs = nonNegativeInteger(firstNumber(other, ['frt', 'first_token_ms'], 0));
  const recordType = RECORD_TYPE_NAMES[type] || 'unknown';
  const createdAt = parseCreatedAt(source.created_at);
  const amount = convertQuota(rawQuota, display);
  const usageReturned = type === 2 && (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || (rawQuota != null && rawQuota !== 0));

  return {
    id: cleanText(source.id, 80),
    requestId: cleanText(source.request_id, 128),
    upstreamRequestId: cleanText(source.upstream_request_id, 128),
    createdAt,
    model: cleanText(source.model_name || source.model, 160),
    recordType,
    recordTypeCode: type,
    success: type === 2 && (statusCode == null || (statusCode >= 200 && statusCode < 400)),
    statusCode,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens,
    usageReturned,
    rawQuota,
    totalCost: amount,
    costUnit: display?.unit || 'quota',
    costExact: Boolean(display?.exact && amount != null),
    costSource: 'provider_log',
    durationSeconds,
    latencyMs: durationSeconds * 1_000,
    firstTokenMs,
    isStream: source.is_stream === true || source.is_stream === 1 || source.is_stream === '1' || source.is_stream === 'true',
    billingSource: cleanText(other.billing_source, 40),
    requestPath: cleanText(other.request_path, 160),
  };
}

export function parseProviderRequestLogs(payload, display, limit = DEFAULT_REQUEST_USAGE_LIMIT, options = {}) {
  if (!payload || payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error(redactedMessage(payload?.message || '第三方逐请求用量响应格式无效'));
  }
  const appType = String(options.appType || '').trim().toLowerCase();
  const strictAppType = options.strictAppType === true;
  const rows = payload.data
    .filter(row => row && typeof row === 'object')
    .filter(row => {
      if (!appType) return true;
      const detected = classifyProviderRequestLogApp(row);
      if (detected) return detected === appType;
      return !strictAppType;
    })
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftTime = finiteNumber(left.row.created_at, 0);
      const rightTime = finiteNumber(right.row.created_at, 0);
      if (rightTime !== leftTime) return rightTime - leftTime;
      const leftId = finiteNumber(left.row.id, 0);
      const rightId = finiteNumber(right.row.id, 0);
      if (rightId !== leftId) return rightId - leftId;
      return left.index - right.index;
    })
    .slice(0, normalizeRequestUsageLimit(limit));
  return rows.map(({ row }) => parseProviderRequestLog(row, display));
}

function fallbackBilling(message, secrets = []) {
  return {
    available: false,
    exact: false,
    unit: 'quota',
    quotaPerUnit: null,
    multiplier: null,
    warning: redactedMessage(message || '站点计费配置未返回', secrets),
  };
}

function providerLabel(provider) {
  return cleanText(provider?.name || '供应商', 80) || '供应商';
}

function failureResult(provider, config, limit, now, message, extra = {}) {
  return {
    success: false,
    providerId: String(provider?.id || ''),
    providerName: providerLabel(provider),
    providerKind: providerKind(provider),
    source: config.adapter,
    interface: describeProviderRequestUsage(provider),
    limit,
    fetchedAt: new Date(now()).toISOString(),
    items: [],
    message: redactedMessage(message || '第三方逐请求用量查询失败', [provider?.apiKey]),
    ...extra,
  };
}

export class ProviderRequestUsageEngine {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.browserBroker = options.browserBroker || null;
    this.now = options.now || Date.now;
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || REQUEST_USAGE_TIMEOUT_MS);
    this.attempts = Math.max(1, Math.min(2, Math.trunc(Number(options.attempts) || REQUEST_USAGE_ATTEMPTS)));
    this.statusCacheTtlMs = Math.max(0, Number(options.statusCacheTtlMs) || 300_000);
    this.statusCache = new Map();
  }

  clearStatusCache() {
    this.statusCache.clear();
  }

  async query(provider, options = {}) {
    const config = providerBackend(provider);
    const limit = normalizeRequestUsageLimit(options.limit);
    const base = {
      providerId: String(provider?.id || ''),
      providerName: providerLabel(provider),
      providerKind: providerKind(provider),
      source: config.adapter,
      interface: describeProviderRequestUsage(provider),
      limit,
      fetchedAt: new Date(this.now()).toISOString(),
      appType: String(options.appType || 'codex'),
    };
    if (!config.supported) {
      return {
        ...base,
        success: false,
        supported: false,
        items: [],
        message: config.reason,
      };
    }
    if (!provider?.apiKey) {
      return failureResult(provider, config, limit, this.now, '供应商没有可用的 API Key', { supported: true });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('第三方逐请求用量查询超时')), this.timeoutMs);
    const externalSignal = options.signal;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    try {
      const logsPromise = this.#fetchProviderJson(
        config,
        config.logPath,
        { Authorization: `Bearer ${provider.apiKey}`, Accept: 'application/json' },
        signal,
      );
      const statusPromise = this.#getStatus(config, signal);
      const [logsResult, statusResult] = await Promise.allSettled([logsPromise, statusPromise]);

      if (logsResult.status === 'rejected') {
        return failureResult(provider, config, limit, this.now, logsResult.reason, {
          supported: true,
          errorType: 'network',
        });
      }
      const logs = logsResult.value;
      if (logs.status !== 200 || logs.payload?.success !== true || !Array.isArray(logs.payload?.data)) {
        const detail = logs.payload?.message || `第三方逐请求用量接口返回 HTTP ${logs.status}`;
        return failureResult(provider, config, limit, this.now, detail, {
          supported: true,
          httpStatus: logs.status,
          errorType: logs.status === 401 || logs.status === 403 ? 'authentication' : 'provider',
        });
      }

      let display = null;
      let billing = fallbackBilling('站点计费配置未返回', [provider.apiKey]);
      if (statusResult.status === 'fulfilled' && statusResult.value.status === 200) {
        try {
          display = parseNewApiDisplayPayload(statusResult.value.payload, providerLabel(provider));
          billing = {
            available: true,
            exact: display.exact,
            displayType: display.displayType,
            unit: display.unit,
            quotaPerUnit: display.quotaPerUnit,
            multiplier: display.multiplier,
            legacy: display.legacy,
          };
        } catch (error) {
          billing = fallbackBilling(error, [provider.apiKey]);
        }
      } else if (statusResult.status === 'rejected') {
        billing = fallbackBilling(statusResult.reason, [provider.apiKey]);
      } else {
        billing = fallbackBilling(`站点计费配置接口返回 HTTP ${statusResult.value.status}`, [provider.apiKey]);
      }

      const items = parseProviderRequestLogs(logs.payload, display, limit, {
        appType: base.appType,
        strictAppType: options.strictAppType === true,
      });
      const statusWarning = billing.available ? '' : billing.warning;
      return {
        ...base,
        success: true,
        supported: true,
        source: 'provider_log',
        requestCount: items.length,
        totalRemoteRecords: Array.isArray(logs.payload.data) ? logs.payload.data.length : items.length,
        appTypeFilter: options.strictAppType === true ? 'strict' : 'compatible',
        billing,
        ...(statusWarning ? { message: statusWarning, degraded: true } : {}),
        items,
      };
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason || error;
      return failureResult(provider, config, limit, this.now, error, { supported: true, errorType: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  async #fetchProviderJson(config, requestPath, headers, signal) {
    let direct = null;
    let directError = null;
    try {
      direct = await fetchJson(
        this.fetchImpl,
        `${config.origin}${requestPath}`,
        headers,
        this.timeoutMs,
        this.attempts,
        signal,
      );
    } catch (error) {
      directError = error;
    }
    const hasJsonPayload = direct?.payload && typeof direct.payload === 'object';
    const browserAvailable = config.browserFallback
      && typeof this.browserBroker?.queryJson === 'function'
      && (typeof this.browserBroker.isConnected !== 'function' || this.browserBroker.isConnected());
    if (!browserAvailable || (direct && direct.status !== 403 && hasJsonPayload)) {
      if (!direct && directError) throw directError;
      return direct;
    }

    const raw = await this.browserBroker.queryJson({
      baseUrl: config.origin,
      requestPath,
      headers,
      navigateRequest: false,
    }, { signal });
    const status = Number(raw?.status) || 0;
    const payload = parseBrowserJson(raw?.text);
    if (status === 0 && !payload) {
      throw new Error(String(raw?.error || directError?.message || '浏览器伴侣未能取得第三方逐请求用量'));
    }
    return {
      status,
      payload,
      text: String(raw?.text || ''),
      browser: true,
    };
  }

  async #getStatus(config, signal) {
    const cached = this.statusCache.get(config.origin);
    if (cached && cached.expiresAt > this.now()) return { status: 200, payload: cached.payload, cached: true };
    const result = await this.#fetchProviderJson(config, config.statusPath, { Accept: 'application/json' }, signal);
    if (result.status === 200 && result.payload?.success === true) {
      this.statusCache.set(config.origin, { payload: result.payload, expiresAt: this.now() + this.statusCacheTtlMs });
    }
    return result;
  }
}
