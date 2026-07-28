import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fetchJson, parseBrowserJson, providerKind } from './hub-provider-adapters.mjs';
import { getRequestUsageTemplate } from './provider-templates.mjs';
import { isTrustedHttpUrl } from './http-allowlist.mjs';

export const DEFAULT_REQUEST_USAGE_LIMIT = 10;
export const MAX_REQUEST_USAGE_LIMIT = 50;

const DEFAULT_QUOTA_PER_UNIT = 500_000;
const REQUEST_USAGE_TIMEOUT_MS = 45_000;
const REQUEST_USAGE_ATTEMPTS = 2;
const ACCOUNT_LOG_PAGE_SIZE = 100;
const ACCOUNT_LOG_LOCAL_LIMIT = 50;
const ACCOUNT_LOG_MIN_MATCHES = 2;
const ACCOUNT_LOG_TIME_TOLERANCE_SECONDS = 3;
const OPENAI_CODEX_SESSION_TEMPLATE_ID = 'openai-codex-session';
const OPENAI_CODEX_SESSION_SOURCE = 'openai_codex_session';
const CODEX_SESSION_FILE_LIMIT = 5_000;

const EXCLUDED_PROVIDER_KINDS = new Set(['cpa']);
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
    if (url.protocol !== 'https:' && !isTrustedHttpUrl(url, provider)) return null;
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

export function defaultRequestUsageTemplateId(provider) {
  const kind = providerKind(provider);
  if (kind === 'openai') return OPENAI_CODEX_SESSION_TEMPLATE_ID;
  if (kind === 'deepseek') return 'response-usage-only';
  if (kind === 'paid') return 'website-session-only';
  if (EXCLUDED_PROVIDER_KINDS.has(kind)) return 'ccswitch-local';
  const configured = configuredOrigin(provider);
  if (!configured) return 'ccswitch-local';
  const adapter = NEW_API_LOG_ADAPTERS.find(item => item.domains.some(domain => hostnameMatches(configured.hostname, domain)));
  return adapter ? 'new-api-token-log' : 'ccswitch-local';
}

function providerBackend(provider, templateId = '') {
  const requestedTemplateId = String(templateId || '');
  const selectedTemplateId = requestedTemplateId || defaultRequestUsageTemplateId(provider);
  const template = getRequestUsageTemplate(selectedTemplateId);
  if (!template) {
    return {
      supported: false,
      adapter: 'invalid-template',
      templateId: selectedTemplateId,
      explicitTemplateId: requestedTemplateId,
      reason: '选择的逐请求用量模板不存在',
    };
  }
  if (selectedTemplateId === OPENAI_CODEX_SESSION_TEMPLATE_ID) {
    if (providerKind(provider) !== 'openai') {
      return {
        supported: false,
        adapter: OPENAI_CODEX_SESSION_TEMPLATE_ID,
        templateId: selectedTemplateId,
        explicitTemplateId: requestedTemplateId,
        reason: 'Codex 官方会话 Token 模板只适用于 OpenAI Official',
      };
    }
    return {
      supported: true,
      adapter: OPENAI_CODEX_SESSION_TEMPLATE_ID,
      templateId: selectedTemplateId,
      explicitTemplateId: requestedTemplateId,
      label: 'OpenAI Official',
    };
  }
  if (selectedTemplateId === 'response-usage-only') {
    return {
      supported: false,
      adapter: 'response-usage-only',
      templateId: selectedTemplateId,
      explicitTemplateId: requestedTemplateId,
      reason: 'DeepSeek 官方没有按 API Key 查询历史逐请求用量的接口；只能在模型响应中读取 usage',
    };
  }
  if (selectedTemplateId === 'website-session-only') {
    return {
      supported: false,
      adapter: 'website-session-only',
      templateId: selectedTemplateId,
      explicitTemplateId: requestedTemplateId,
      reason: '付费站真实消费记录只提供官网登录会话接口；当前不读取网页登录态，改用 CCSwitch 本地记录',
    };
  }
  if (selectedTemplateId === 'ccswitch-local') {
    return {
      supported: false,
      adapter: 'ccswitch-local',
      templateId: selectedTemplateId,
      explicitTemplateId: requestedTemplateId,
      reason: '已选择 CCSwitch 本地请求记录，不查询第三方逐请求接口',
    };
  }

  const configured = configuredOrigin(provider);
  if (!configured) {
    return {
      supported: false,
      adapter: 'unconfigured',
      templateId: selectedTemplateId,
      explicitTemplateId: requestedTemplateId,
      reason: '供应商没有可安全查询的 HTTPS Base URL',
    };
  }
  const adapter = NEW_API_LOG_ADAPTERS.find(item => item.domains.some(domain => hostnameMatches(configured.hostname, domain)));
  const explicitlySelected = Boolean(requestedTemplateId);
  return {
    supported: true,
    adapter: 'new-api-token-log',
    templateId: selectedTemplateId,
    explicitTemplateId: requestedTemplateId,
    adapterId: adapter?.id || 'configured-new-api',
    label: adapter?.label || cleanText(provider?.name || '供应商', 80) || '供应商',
    logPath: '/api/log/token',
    statusPath: '/api/status',
    origin: explicitlySelected ? configured.origin : (adapter?.origin || configured.origin),
    hostname: configured.hostname,
    browserFallback: configured.origin.startsWith('https://')
      && (explicitlySelected || adapter?.browserFallback === true),
  };
}

export function normalizeRequestUsageLimit(value = DEFAULT_REQUEST_USAGE_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_USAGE_LIMIT;
  return Math.max(1, Math.min(MAX_REQUEST_USAGE_LIMIT, Math.trunc(parsed)));
}

export function describeProviderRequestUsage(provider, templateId = '') {
  const backend = providerBackend(provider, templateId);
  if (backend.adapter === OPENAI_CODEX_SESSION_TEMPLATE_ID) {
    return {
      supported: backend.supported === true,
      adapter: backend.adapter,
      templateId: backend.templateId || '',
      providerAdapter: 'codex-session-token-count',
      method: backend.supported ? 'LOCAL' : '',
      requestUrl: backend.supported ? '%USERPROFILE%\\.codex\\sessions\\**\\*.jsonl' : '',
      configurationUrl: '',
      authentication: backend.supported ? '当前 Codex 官方账号 ID 匹配' : '',
      requiresBrowser: false,
      executor: backend.supported ? 'Balance Hub 只读本机 Codex 会话 Token 事件' : '',
      label: 'Codex 官方逐请求 Token',
      notes: backend.supported ? [
        '只解析 model_provider=openai 的 session_meta、turn_context 与 token_count，不读取或返回对话正文',
        '所选 OpenAI Official 的 account_id 必须与当前 Codex 登录账号一致',
        '输入、缓存输入、输出和推理 Token 来自 Codex 官方响应事件',
        'ChatGPT 套餐不提供逐请求货币金额，因此费用显示为不可用而不是伪造为 0',
      ] : [],
      ...(backend.supported ? {} : { reason: backend.reason }),
    };
  }
  const common = {
    supported: backend.supported === true,
    adapter: backend.adapter,
    templateId: backend.templateId || '',
    providerAdapter: backend.adapterId || '',
    method: backend.supported ? 'GET' : '',
    requestUrl: backend.supported ? `${backend.origin}${backend.logPath}` : '',
    configurationUrl: backend.supported ? `${backend.origin}${backend.statusPath}` : '',
    authentication: backend.supported ? 'Bearer API Key' : '',
    requiresBrowser: backend.browserFallback === true,
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
      'Token 日志为空或受 WAF 阻断时，只有账户日志与至少两条本地成功请求关联到同一 Token 后才会采用',
      '无法可靠归属时拒绝账户总日志，并由 Hub 明确回退 CCSwitch 本地记录',
      ...(backend.browserFallback ? ['直接请求被 WAF 拦截时，允许通过已连接的浏览器伴侣读取同一 API Key 接口'] : []),
    ],
  };
}

function codexSessionInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function codexSessionTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function codexSessionAccountId(provider) {
  return String(provider?.auth?.tokens?.account_id || provider?.auth?.account_id || '').trim();
}

function accountScopeError(message) {
  const error = new Error(message);
  error.code = 'ACCOUNT_SCOPE';
  return error;
}

function listCodexSessionFiles(root, output, maximum) {
  if (!root || output.length >= maximum) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= maximum) break;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listCodexSessionFiles(filename, output, maximum);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(filename);
        output.push({ filename, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
}

function codexSessionItem(sessionId, segment, cumulativeTokens, event, model) {
  const last = event?.payload?.info?.last_token_usage;
  const inputTokens = codexSessionInteger(last?.input_tokens, 0);
  const outputTokens = codexSessionInteger(last?.output_tokens, 0);
  const cacheReadTokens = codexSessionInteger(last?.cached_input_tokens, 0);
  const reasoningTokens = codexSessionInteger(last?.reasoning_output_tokens, 0);
  const totalTokens = codexSessionInteger(last?.total_tokens, inputTokens + outputTokens);
  const createdAt = codexSessionTimestamp(event?.timestamp);
  if (!createdAt || totalTokens <= 0) return null;
  return {
    id: `${sessionId}:${segment}:${cumulativeTokens}`,
    requestId: '',
    upstreamRequestId: '',
    createdAt,
    model: cleanText(model, 160),
    recordType: 'consume',
    recordTypeCode: 2,
    success: true,
    statusCode: 200,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    reasoningTokens,
    totalTokens,
    usageReturned: true,
    rawQuota: null,
    totalCost: null,
    costUnit: 'subscription',
    costExact: false,
    costSource: OPENAI_CODEX_SESSION_SOURCE,
    durationSeconds: 0,
    latencyMs: null,
    firstTokenMs: null,
    isStream: true,
    billingSource: 'chatgpt_subscription',
    requestPath: 'Codex official session',
    planType: cleanText(event?.payload?.rate_limits?.plan_type, 40),
  };
}

export class CodexSessionUsageReader {
  constructor(options = {}) {
    const userProfile = String(process.env.USERPROFILE || '').trim();
    this.codexHome = String(options.codexHome || (userProfile ? path.join(userProfile, '.codex') : ''));
    this.maximumFiles = Math.max(1, Math.min(20_000, Number(options.maximumFiles) || CODEX_SESSION_FILE_LIMIT));
    this.fileCache = new Map();
    this.fileScans = new Map();
  }

  async query(provider, options = {}) {
    const configuredAccountId = codexSessionAccountId(provider);
    const currentAccountId = this.#currentAccountId();
    if (!configuredAccountId) throw accountScopeError('OpenAI Official 配置缺少 account_id，无法归属 Codex 官方会话');
    if (!currentAccountId) throw accountScopeError('当前 Codex 没有可识别的官方登录账号');
    if (configuredAccountId !== currentAccountId) {
      throw accountScopeError('当前 Codex 登录账号不匹配这个 OpenAI Official 配置，已拒绝混用官方会话记录');
    }

    const files = [];
    listCodexSessionFiles(path.join(this.codexHome, 'sessions'), files, this.maximumFiles);
    listCodexSessionFiles(path.join(this.codexHome, 'archived_sessions'), files, this.maximumFiles);
    const activeFiles = new Set(files.map(file => file.filename));
    for (const filename of this.fileCache.keys()) {
      if (!activeFiles.has(filename)) this.fileCache.delete(filename);
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.filename.localeCompare(left.filename));

    const items = [];
    let officialSessionCount = 0;
    for (const file of files) {
      const result = await this.#scanFile(file);
      if (!result.official) continue;
      officialSessionCount += 1;
      items.push(...result.items);
    }
    items.sort((left, right) => {
      const timeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return timeDifference || right.id.localeCompare(left.id);
    });
    const limit = normalizeRequestUsageLimit(options.limit);
    return {
      items: items.slice(0, limit),
      totalRecords: items.length,
      officialSessionCount,
    };
  }

  #currentAccountId() {
    if (!this.codexHome) return '';
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(this.codexHome, 'auth.json'), 'utf8'));
      return String(auth?.tokens?.account_id || auth?.auth?.tokens?.account_id || '').trim();
    } catch {
      return '';
    }
  }

  #scanFile(file) {
    const signature = `${file.size}:${file.mtimeMs}`;
    const cached = this.fileCache.get(file.filename);
    if (cached?.signature === signature) return Promise.resolve(cached.result);
    const active = this.fileScans.get(file.filename);
    if (active?.signature === signature) return active.promise;
    const promise = this.#scanFileUncached(file.filename)
      .then(result => {
        this.fileCache.set(file.filename, { signature, result });
        return result;
      })
      .finally(() => {
        if (this.fileScans.get(file.filename)?.promise === promise) this.fileScans.delete(file.filename);
      });
    this.fileScans.set(file.filename, { signature, promise });
    return promise;
  }

  async #scanFileUncached(filename) {
    const input = fs.createReadStream(filename, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let official = null;
    let sessionId = path.basename(filename, path.extname(filename));
    let model = '';
    let previousCumulative = 0;
    let segment = 0;
    const items = [];
    try {
      for await (const line of lines) {
        if (official !== true && line.includes('"type":"session_meta"')) {
          try {
            const event = JSON.parse(line);
            sessionId = cleanText(event?.payload?.id || sessionId, 128) || sessionId;
            official = String(event?.payload?.model_provider || '') === 'openai';
          } catch {
            official = false;
          }
          if (!official) break;
          continue;
        }
        if (official !== true) continue;
        if (line.includes('"type":"turn_context"')) {
          try {
            const event = JSON.parse(line);
            model = cleanText(event?.payload?.model, 160);
          } catch {}
          continue;
        }
        if (!line.includes('"type":"event_msg"') || !line.includes('"type":"token_count"')) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.payload?.type !== 'token_count' || !event?.payload?.info) continue;
        const cumulativeTokens = codexSessionInteger(event.payload.info?.total_token_usage?.total_tokens);
        if (cumulativeTokens == null) continue;
        if (cumulativeTokens < previousCumulative) {
          previousCumulative = 0;
          segment += 1;
        }
        if (cumulativeTokens <= previousCumulative) continue;
        previousCumulative = cumulativeTokens;
        const item = codexSessionItem(sessionId, segment, cumulativeTokens, event, model);
        if (item) items.push(item);
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return { official: official === true, items };
  }
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
    const hasLegacyDisplayFlag = typeof data.display_in_currency === 'boolean';
    if (!hasLegacyDisplayFlag) {
      throw new Error(`${providerLabel}站点配置缺少 New API 计费字段`);
    }
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

function localRequestTimestamp(row) {
  const milliseconds = Date.parse(String(row?.createdAt || ''));
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1_000 : null;
}

function localRequestModels(row) {
  return new Set([row?.model, row?.requestModel]
    .map(value => cleanText(value, 160).toLocaleLowerCase('en-US'))
    .filter(Boolean));
}

function isCorrelatableLocalRequest(row) {
  const statusCode = integerOrNull(row?.statusCode);
  const inputTokens = integerOrNull(row?.inputTokens);
  const outputTokens = integerOrNull(row?.outputTokens);
  return statusCode != null
    && statusCode >= 200
    && statusCode < 400
    && inputTokens != null
    && inputTokens >= 0
    && outputTokens != null
    && outputTokens >= 0
    && inputTokens + outputTokens > 0
    && localRequestTimestamp(row) != null
    && localRequestModels(row).size > 0;
}

function accountLogTokenIdentity(row) {
  const tokenId = integerOrNull(row?.token_id);
  if (tokenId != null && tokenId > 0) return `id:${tokenId}`;
  const tokenName = cleanText(row?.token_name, 160).toLocaleLowerCase('en-US');
  return tokenName ? `name:${tokenName}` : '';
}

function parseAccountLogRows(payload, providerName) {
  const data = payload?.data;
  if (
    payload?.success !== true
    || !data
    || typeof data !== 'object'
    || Array.isArray(data)
    || !Array.isArray(data.items)
  ) {
    throw new Error(redactedMessage(payload?.message || `${providerName}账户日志响应格式无效`));
  }
  if (data.items.length > 0 && !data.items.some(isProviderRequestLogRow)) {
    throw new Error(`${providerName}账户日志没有可识别的 New API 日志行`);
  }
  return data.items.filter(isProviderRequestLogRow);
}

function accountLogRowMatchesLocal(row, local) {
  if (Number(row?.type) !== 2) return false;
  const remoteTimestamp = finiteNumber(row?.created_at);
  const localTimestamp = localRequestTimestamp(local);
  if (
    remoteTimestamp == null
    || localTimestamp == null
    || Math.abs(remoteTimestamp - localTimestamp) > ACCOUNT_LOG_TIME_TOLERANCE_SECONDS
  ) return false;
  const remoteModel = cleanText(row?.model_name || row?.model, 160).toLocaleLowerCase('en-US');
  if (!remoteModel || !localRequestModels(local).has(remoteModel)) return false;
  return integerOrNull(row?.prompt_tokens) === integerOrNull(local?.inputTokens)
    && integerOrNull(row?.completion_tokens) === integerOrNull(local?.outputTokens);
}

function correlateAccountLogRows(accountRows, localRows, appType = '') {
  const normalizedAppType = String(appType || '').trim().toLowerCase();
  const remote = accountRows
    .map((row, index) => ({ row, index, identity: accountLogTokenIdentity(row) }))
    .filter(item => {
      if (!item.identity || Number(item.row?.type) !== 2) return false;
      const detected = classifyProviderRequestLogApp(item.row);
      return !normalizedAppType || !detected || detected === normalizedAppType;
    });
  const local = localRows
    .filter(isCorrelatableLocalRequest)
    .map(row => ({ row, timestamp: localRequestTimestamp(row) }))
    .sort((left, right) => right.timestamp - left.timestamp);
  const usedRemote = new Set();
  const matches = [];
  for (const localItem of local) {
    const candidates = remote.filter(item => !usedRemote.has(item.index) && accountLogRowMatchesLocal(item.row, localItem.row));
    const identities = new Set(candidates.map(item => item.identity));
    if (identities.size !== 1) continue;
    const selected = candidates[0];
    usedRemote.add(selected.index);
    matches.push({ identity: selected.identity, timestamp: localItem.timestamp, remote: selected });
  }
  if (matches.length < ACCOUNT_LOG_MIN_MATCHES) return null;
  const identity = matches[0].identity;
  let leadingMatches = 0;
  for (const match of matches) {
    if (match.identity !== identity) break;
    leadingMatches += 1;
  }
  if (leadingMatches < ACCOUNT_LOG_MIN_MATCHES) return null;
  const identityMatches = matches.filter(match => match.identity === identity);
  const rows = identity.startsWith('id:')
    ? remote.filter(item => item.identity === identity).map(item => item.row)
    : identityMatches.map(match => match.remote.row);
  return {
    rows,
    matchCount: identityMatches.length,
    identityType: identity.startsWith('id:') ? 'token-id' : 'token-name',
  };
}

function accountLogRequestPath(localRows) {
  const query = new URLSearchParams({
    p: '1',
    page_size: String(ACCOUNT_LOG_PAGE_SIZE),
    type: '0',
  });
  const timestamps = localRows.map(localRequestTimestamp).filter(value => value != null);
  if (timestamps.length > 0) {
    query.set('start_timestamp', String(Math.max(1, Math.floor(Math.min(...timestamps)) - 5)));
    query.set('end_timestamp', String(Math.ceil(Math.max(...timestamps)) + 5));
  }
  return `/api/log/self/?${query.toString()}`;
}

function parseCacheCreationTokens(other) {
  const direct = firstNumber(other, ['cache_write_tokens', 'cache_creation_tokens']);
  if (direct != null) return nonNegativeInteger(direct);
  return nonNegativeInteger(
    firstNumber(other, ['cache_creation_tokens_5m'], 0)
      + firstNumber(other, ['cache_creation_tokens_1h'], 0),
  );
}

export function isProviderRequestLogRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const type = Number(row.type);
  if (!Number.isSafeInteger(type) || !Object.hasOwn(RECORD_TYPE_NAMES, type)) return false;
  const hasIdentity = ['id', 'request_id', 'created_at'].some(key => {
    if (!Object.hasOwn(row, key)) return false;
    const value = row[key];
    return value != null && String(value).trim() !== '';
  });
  const hasLogData = [
    'content', 'model_name', 'model', 'quota', 'prompt_tokens', 'completion_tokens',
    'use_time', 'token_name', 'channel_name', 'other',
  ].some(key => Object.hasOwn(row, key));
  return hasIdentity && hasLogData;
}

function hasMeaningfulField(source, key) {
  if (!source || !Object.hasOwn(source, key)) return false;
  const value = source[key];
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'boolean';
}

function isProviderRequestActivityRow(row) {
  if (!isProviderRequestLogRow(row) || ![2, 5].includes(Number(row.type))) return false;
  if (['model_name', 'model', 'token_name', 'channel_name'].some(key => cleanText(row[key], 160))) return true;
  if (['quota', 'prompt_tokens', 'completion_tokens', 'use_time'].some(key => {
    if (!Object.hasOwn(row, key)) return false;
    const value = finiteNumber(row[key]);
    return value != null && value >= 0;
  })) return true;
  const other = parseOther(row.other);
  return [
    'request_path', 'path', 'status_code', 'http_status', 'error_code', 'error_type',
    'cache_tokens', 'cached_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'cache_creation_tokens', 'cache_creation_tokens_5m', 'cache_creation_tokens_1h',
    'frt', 'first_token_ms', 'billing_source',
  ].some(key => hasMeaningfulField(other, key));
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
  if (payload.data.length > 0 && !payload.data.some(isProviderRequestLogRow)) {
    throw new Error('第三方逐请求用量响应没有可识别的 New API 日志行');
  }
  if (payload.data.length > 0 && !payload.data.some(isProviderRequestActivityRow)) {
    throw new Error('第三方逐请求用量响应没有可识别的 New API 请求日志行');
  }
  const rows = payload.data
    .filter(isProviderRequestActivityRow)
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
    interface: describeProviderRequestUsage(provider, config.explicitTemplateId),
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
    this.codexSessionUsageReader = options.codexSessionUsageReader || new CodexSessionUsageReader(options.codexSessionUsageOptions);
  }

  clearStatusCache() {
    this.statusCache.clear();
  }

  async query(provider, options = {}) {
    const config = providerBackend(provider, options.requestUsageTemplateId);
    const limit = normalizeRequestUsageLimit(options.limit);
    const base = {
      providerId: String(provider?.id || ''),
      providerName: providerLabel(provider),
      providerKind: providerKind(provider),
      source: config.adapter,
      interface: describeProviderRequestUsage(provider, config.explicitTemplateId),
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
    if (config.adapter === OPENAI_CODEX_SESSION_TEMPLATE_ID) {
      try {
        const sessionResult = await this.codexSessionUsageReader.query(provider, { limit });
        const warning = 'Token 来自 Codex 官方会话；ChatGPT 套餐不提供逐请求货币金额';
        return {
          ...base,
          success: true,
          supported: true,
          source: OPENAI_CODEX_SESSION_SOURCE,
          requestCount: sessionResult.items.length,
          totalOfficialRecords: sessionResult.totalRecords,
          officialSessionCount: sessionResult.officialSessionCount,
          schemaValidated: true,
          billing: {
            available: false,
            exact: false,
            unit: 'subscription',
            quotaPerUnit: null,
            multiplier: null,
            warning,
          },
          degraded: true,
          message: warning,
          items: sessionResult.items,
        };
      } catch (error) {
        return failureResult(provider, config, limit, this.now, error, {
          supported: true,
          errorType: error?.code === 'ACCOUNT_SCOPE' ? 'account_scope' : 'local',
        });
      }
    }
    if (!provider?.apiKey) {
      return failureResult(provider, config, limit, this.now, '供应商没有可用的 API Key', { supported: true });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('第三方逐请求用量查询超时')), this.timeoutMs);
    const externalSignal = options.signal;
    const requestCache = options.requestCache || null;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    try {
      const logsPromise = this.#fetchProviderJson(
        config,
        config.logPath,
        { Authorization: `Bearer ${provider.apiKey}`, Accept: 'application/json' },
        signal,
        requestCache,
      );
      const statusPromise = this.#getStatus(config, signal, options.bypassCache === true, requestCache);
      const [logsResult, statusResult] = await Promise.allSettled([logsPromise, statusPromise]);

      if (logsResult.status === 'rejected') {
        return failureResult(provider, config, limit, this.now, logsResult.reason, {
          supported: true,
          errorType: 'network',
        });
      }
      const logs = logsResult.value;
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

      if (logs.status !== 200 || logs.payload?.success !== true || !Array.isArray(logs.payload?.data)) {
        const tokenLogWafBlocked = logs.status === 403 || (logs.status === 200 && !logs.payload);
        if (tokenLogWafBlocked) {
          const accountLogResult = await this.#queryCorrelatedAccountLogs(
            provider,
            config,
            base,
            display,
            billing,
            limit,
            options,
            signal,
          );
          if (accountLogResult?.success === true) return accountLogResult;
        }
        const detail = logs.payload?.message || `第三方逐请求用量接口返回 HTTP ${logs.status}`;
        return failureResult(provider, config, limit, this.now, detail, {
          supported: true,
          httpStatus: logs.status,
          errorType: logs.status === 401 || logs.status === 403 ? 'authentication' : 'provider',
        });
      }

      let items;
      try {
        items = parseProviderRequestLogs(logs.payload, display, limit, {
          appType: base.appType,
          strictAppType: options.strictAppType === true,
        });
      } catch (error) {
        return failureResult(provider, config, limit, this.now, error, {
          supported: true,
          httpStatus: logs.status,
          errorType: 'schema',
        });
      }
      if (logs.payload.data.length === 0) {
        const accountLogResult = await this.#queryCorrelatedAccountLogs(
          provider,
          config,
          base,
          display,
          billing,
          limit,
          options,
          signal,
        );
        if (accountLogResult) return accountLogResult;
        if (!billing.available) {
          return failureResult(provider, config, limit, this.now, '逐请求日志为空，且站点配置无法验证 New API 响应结构', {
            supported: true,
            httpStatus: logs.status,
            errorType: 'schema',
          });
        }
      }
      const statusWarning = billing.available ? '' : billing.warning;
      return {
        ...base,
        success: true,
        supported: true,
        source: 'provider_log',
        requestCount: items.length,
        totalRemoteRecords: Array.isArray(logs.payload.data) ? logs.payload.data.length : items.length,
        appTypeFilter: options.strictAppType === true ? 'strict' : 'compatible',
        schemaValidated: true,
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

  async #queryCorrelatedAccountLogs(provider, config, base, display, billing, limit, options, signal) {
    if (typeof options.getLocalRequestRows !== 'function') return null;
    let localRows;
    try {
      localRows = await options.getLocalRequestRows(ACCOUNT_LOG_LOCAL_LIMIT);
    } catch (error) {
      return failureResult(provider, config, limit, this.now, `浏览器账户日志无法归属到当前供应商 API Key：${error}`, {
        supported: true,
        source: 'provider_account_log',
        httpStatus: 200,
        errorType: 'account_scope',
        accountLogAutoDetected: true,
      });
    }
    if (!Array.isArray(localRows)) return null;
    const correlatableLocalRows = localRows.filter(isCorrelatableLocalRequest);
    if (correlatableLocalRows.length === 0) return null;
    const accountScopeFailure = () => failureResult(
      provider,
      config,
      limit,
      this.now,
      '浏览器账户日志无法归属到当前供应商 API Key；已拒绝把账户总日志冒充单 Key 日志',
      {
        supported: true,
        source: 'provider_account_log',
        httpStatus: 200,
        errorType: 'account_scope',
        accountLogAutoDetected: true,
      },
    );
    if (correlatableLocalRows.length < ACCOUNT_LOG_MIN_MATCHES) return accountScopeFailure();
    if (!config.origin.startsWith('https://')) return accountScopeFailure();
    if (
      typeof this.browserBroker?.listQueryClients !== 'function'
      || typeof this.browserBroker?.queryJsonOnClient !== 'function'
      || (typeof this.browserBroker.isConnected === 'function' && !this.browserBroker.isConnected())
    ) return accountScopeFailure();

    let clients;
    try {
      clients = this.browserBroker.listQueryClients(config.origin).slice(0, 6);
    } catch {
      return accountScopeFailure();
    }
    const boundClientRef = String(options.accountBinding?.clientRef || '').trim();
    if (boundClientRef) {
      clients = clients.filter(client => String(client.clientRef || client.clientId || '') === boundClientRef);
    } else {
      clients.sort((left, right) => Number(right.hasSession === true) - Number(left.hasSession === true));
    }
    if (clients.length === 0) return accountScopeFailure();

    const requestPath = accountLogRequestPath(correlatableLocalRows);
    for (const client of clients) {
      try {
        const raw = await this.browserBroker.queryJsonOnClient(
          client.clientRef || client.clientId,
          {
            baseUrl: config.origin,
            requestPath,
            headers: { Accept: 'application/json' },
            userHeader: 'New-Api-User',
            navigateRequest: false,
          },
          { signal },
        );
        if (raw?.identityMissing === true || Number(raw?.status) !== 200) continue;
        const payload = parseBrowserJson(raw?.text);
        const accountRows = parseAccountLogRows(payload, providerLabel(provider));
        const correlation = correlateAccountLogRows(accountRows, correlatableLocalRows, base.appType);
        if (!correlation) continue;
        const items = parseProviderRequestLogs({ success: true, message: '', data: correlation.rows }, display, limit, {
          appType: base.appType,
          strictAppType: options.strictAppType === true,
        });
        return {
          ...base,
          success: true,
          supported: true,
          source: 'provider_account_log',
          requestCount: items.length,
          totalRemoteRecords: correlation.rows.length,
          totalAccountRecords: accountRows.length,
          appTypeFilter: options.strictAppType === true ? 'strict' : 'compatible',
          schemaValidated: true,
          billing,
          accountLogAutoDetected: true,
          keyAssociation: 'local-correlation',
          correlationIdentity: correlation.identityType,
          localCorrelationMatches: correlation.matchCount,
          accountBrowser: cleanText(client.browser, 40),
          ...(!billing.available ? { message: billing.warning, degraded: true } : {}),
          items,
        };
      } catch {
        // Try the next exact browser client. No account payload is trusted until
        // it correlates with the provider's recent successful CCSwitch rows.
      }
    }
    return accountScopeFailure();
  }

  async #fetchProviderJson(config, requestPath, headers, signal, requestCache = null) {
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
        500,
        requestCache,
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

  async #getStatus(config, signal, bypassCache = false, requestCache = null) {
    const cached = this.statusCache.get(config.origin);
    if (!bypassCache && cached && cached.expiresAt > this.now()) return { status: 200, payload: cached.payload, cached: true };
    const result = await this.#fetchProviderJson(config, config.statusPath, { Accept: 'application/json' }, signal, requestCache);
    if (result.status === 200 && result.payload?.success === true) {
      this.statusCache.set(config.origin, { payload: result.payload, expiresAt: this.now() + this.statusCacheTtlMs });
    }
    return result;
  }
}
