import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROVIDER_QUERY_TIMEOUT_MS } from '../browser-companion/protocol.js';
import { normalizeUsage, readResponseTextLimited } from './usage-normalization.mjs';
import { getBalanceTemplate, normalizeProviderTemplateOrigin } from './provider-templates.mjs';
import { isTrustedHttpUrl } from './http-allowlist.mjs';
import { getHomeDir } from './platform.mjs';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const QUOTA_PER_USD = 500_000;
const WHAM_BROWSER_PROBE_TIMEOUT_MS = 5_000;
const WHAM_BROWSER_RACE_DELAY_MS = 400;
const WHAM_DIRECT_BACKOFF_MS = 300_000;
const WHAM_RESULT_CACHE_MS = 30_000;
const MAX_CPA_AUTH_FILES = 64;
const MAX_CPA_AUTH_DIRECTORY_ENTRIES = 4_096;
const MAX_CPA_AUTH_FILE_BYTES = 1_000_000;
const PROVIDER_SCOPED_NAME = Symbol('providerScopedName');
const API_KEY_NO_LOGIN = 'API Key 直接查询，无需官网登录';

function joinedDetails(...values) {
  return values.map(value => String(value || '').trim()).filter(Boolean).join('；');
}

function apiKeyDetails(...values) {
  return joinedDetails(...values, API_KEY_NO_LOGIN);
}

export function parseBrowserJson(text) {
  const source = String(text || '').trim();
  if (!source || source.length > 2_000_000) return null;
  try {
    return JSON.parse(source);
  } catch {
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try { return JSON.parse(source.slice(firstBrace, lastBrace + 1)); } catch {}
    return null;
  }
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function schemaNumber(value, field) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) {
    throw new Error(`余额响应缺少有效 ${field}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`余额响应中的 ${field} 必须是非负有限数值`);
  return number;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function parseNewApiBalancePayload(payload) {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.success !== true || !data) throw new Error(String(root?.message || '第三方网站余额响应缺少 success/data'));
  const quota = schemaNumber(data.quota, 'quota');
  const usedQuota = schemaNumber(data.used_quota, 'used_quota');
  const requestCount = data.request_count == null ? null : schemaNumber(data.request_count, 'request_count');
  return {
    group: typeof data.group === 'string' ? data.group.trim() : '',
    remaining: quota / QUOTA_PER_USD,
    used: usedQuota / QUOTA_PER_USD,
    total: (quota + usedQuota) / QUOTA_PER_USD,
    requestCount,
  };
}

function newApiAccountId(payload) {
  const root = record(payload);
  const data = record(root?.data) || root;
  const nestedUser = record(data?.user);
  const value = data?.id ?? data?.user_id ?? data?.userId ?? nestedUser?.id;
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function anyRouterAccountRef(origin, clientRef, accountId) {
  return crypto.createHash('sha256')
    .update(String(origin || ''))
    .update('\0')
    .update(String(clientRef || ''))
    .update('\0')
    .update(String(accountId || ''))
    .digest('base64url');
}

export function parseDeepSeekBalancePayload(payload) {
  const root = record(payload);
  if (root?.is_available !== true) throw new Error(String(root?.message || 'DeepSeek 余额当前不可用'));
  if (!Array.isArray(root.balance_infos) || root.balance_infos.length === 0) {
    throw new Error('DeepSeek 余额响应缺少 balance_infos');
  }
  return root.balance_infos.map((item, index) => {
    const balance = record(item);
    if (!balance) throw new Error(`DeepSeek balance_infos[${index}] 格式无效`);
    const currency = typeof balance.currency === 'string' ? balance.currency.trim() : '';
    if (!currency) throw new Error(`DeepSeek balance_infos[${index}] 缺少 currency`);
    return { currency, value: schemaNumber(balance.total_balance, `balance_infos[${index}].total_balance`) };
  });
}

export function parsePackyBalancePayload(payload) {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.code !== true || !data) throw new Error(String(root?.message || 'New API 重置周期额度响应缺少 code/data'));
  const availableQuota = schemaNumber(data.total_available, 'total_available');
  const usedQuota = schemaNumber(data.total_used, 'total_used');
  if (typeof data.quota_reset_period !== 'string') throw new Error('New API 重置周期额度响应缺少有效 quota_reset_period');
  if (data.unlimited_quota != null && typeof data.unlimited_quota !== 'boolean') {
    throw new Error('New API 重置周期额度响应中的 unlimited_quota 必须是布尔值');
  }
  const unlimited = typeof data.unlimited_quota === 'boolean' ? data.unlimited_quota : null;
  return {
    remaining: availableQuota / QUOTA_PER_USD,
    used: usedQuota / QUOTA_PER_USD,
    total: (availableQuota + usedQuota) / QUOTA_PER_USD,
    unlimited,
    quotaMode: unlimited === true ? 'unlimited-effective' : unlimited === false ? 'finite-key' : 'effective-key',
    resetPeriod: typeof data.quota_reset_period === 'string' && data.quota_reset_period.trim()
      ? data.quota_reset_period.trim()
      : '未知',
  };
}

function parseQuotaWindow(value, label) {
  const source = record(value);
  if (!source) throw new Error(`窗口额度响应缺少 ${label}`);
  const total = schemaNumber(source.total, `${label}.total`);
  const used = schemaNumber(source.used, `${label}.used`);
  const remaining = schemaNumber(source.remaining, `${label}.remaining`);
  if (total <= 0) throw new Error(`窗口额度响应中的 ${label}.total 必须大于 0`);
  const expectedTotal = used + remaining;
  const totalTolerance = Math.max(1e-6, Math.abs(total) * 1e-9);
  if (Math.abs(total - expectedTotal) > totalTolerance) {
    throw new Error(`窗口额度响应中的 ${label}.total 必须等于 used + remaining`);
  }
  return { total, used, remaining };
}

export function parseWindowBalancePayload(payload) {
  const root = record(payload);
  if (!root) throw new Error('窗口额度响应格式无效');
  const active = root.status === 'ok' || (root.status == null && root.is_active === true);
  if (!active) throw new Error(String(root.message || root.reason || '窗口额度响应缺少有效状态'));
  const quota = record(root.quota);
  const shortWindow = parseQuotaWindow(
    record(quota?.['3h']) || { total: root.limit_3h, used: root.used_3h, remaining: root.balance_3h },
    '3h',
  );
  const daily = parseQuotaWindow(
    record(quota?.daily) || { total: root.limit_1d, used: root.used_1d, remaining: root.balance_1d },
    'daily',
  );
  return {
    shortWindow,
    daily,
    unit: typeof root.unit === 'string' ? root.unit.trim().slice(0, 24) : '',
  };
}

const DEFAULT_KNOWN_NEW_API_DISPLAY = Object.freeze({ quotaPerUnit: QUOTA_PER_USD, multiplier: 1, unit: 'USD' });

function parseKnownNewApiDisplayPayload(payload, providerLabel) {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.success !== true || !data) throw new Error(String(root?.message || `${providerLabel}站点配置响应缺少 success/data`));
  const displayType = String(data.quota_display_type || '').trim().toUpperCase();
  if (!displayType) {
    if (typeof data.display_in_currency !== 'boolean') {
      throw new Error(`${providerLabel}站点配置缺少有效 quota_display_type`);
    }
    if (data.display_in_currency === false) return { quotaPerUnit: 1, multiplier: 1, unit: 'quota' };
    const legacyQuotaPerUnit = data.quota_per_unit == null
      ? QUOTA_PER_USD
      : schemaNumber(data.quota_per_unit, 'quota_per_unit');
    if (legacyQuotaPerUnit <= 0) throw new Error(`${providerLabel}站点配置中的 quota_per_unit 必须大于 0`);
    return { quotaPerUnit: legacyQuotaPerUnit, multiplier: 1, unit: 'USD' };
  }
  if (!['USD', 'CNY', 'CUSTOM', 'TOKENS'].includes(displayType)) throw new Error(`${providerLabel}站点配置缺少有效 quota_display_type`);
  if (displayType === 'TOKENS') return { quotaPerUnit: 1, multiplier: 1, unit: 'tokens' };
  const quotaPerUnit = schemaNumber(data.quota_per_unit, 'quota_per_unit');
  if (quotaPerUnit <= 0) throw new Error(`${providerLabel}站点配置中的 quota_per_unit 必须大于 0`);
  if (displayType === 'CNY') {
    return { quotaPerUnit, multiplier: schemaNumber(data.usd_exchange_rate, 'usd_exchange_rate'), unit: 'CNY' };
  }
  if (displayType === 'CUSTOM') {
    const symbol = typeof data.custom_currency_symbol === 'string' ? data.custom_currency_symbol.trim().slice(0, 16) : '';
    return {
      quotaPerUnit,
      multiplier: schemaNumber(data.custom_currency_exchange_rate, 'custom_currency_exchange_rate'),
      unit: symbol || 'custom',
    };
  }
  return { quotaPerUnit, multiplier: 1, unit: 'USD' };
}

export function parseJianzhileDisplayPayload(payload) {
  return parseKnownNewApiDisplayPayload(payload, '简直了');
}

export function parseFreelyDisplayPayload(payload) {
  return parseKnownNewApiDisplayPayload(payload, 'freely');
}

function displayKnownNewApiQuota(value, display) {
  return value / display.quotaPerUnit * display.multiplier;
}

function parseKnownNewApiTokenPayload(payload, display, providerLabel) {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.code !== true || !data) throw new Error(String(root?.message || `${providerLabel} API Key 额度响应缺少 code/data`));
  if (typeof data.unlimited_quota !== 'boolean') throw new Error(`${providerLabel} API Key 额度响应缺少 unlimited_quota`);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (data.unlimited_quota) {
    const usedQuota = data.total_used == null ? null : schemaNumber(data.total_used, 'total_used');
    return {
      name,
      unlimited: true,
      remaining: null,
      used: usedQuota == null ? null : displayKnownNewApiQuota(usedQuota, display),
      total: null,
    };
  }
  const remainingQuota = schemaNumber(data.total_available, 'total_available');
  const usedQuota = schemaNumber(data.total_used, 'total_used');
  const totalQuota = schemaNumber(data.total_granted, 'total_granted');
  const expectedTotalQuota = remainingQuota + usedQuota;
  const totalTolerance = Math.max(1e-6, Math.abs(totalQuota) * 1e-9);
  if (Math.abs(totalQuota - expectedTotalQuota) > totalTolerance) {
    throw new Error(`${providerLabel} API Key 额度响应中的 total_granted 与 total_available + total_used 不一致`);
  }
  return {
    name,
    unlimited: false,
    remaining: displayKnownNewApiQuota(remainingQuota, display),
    used: displayKnownNewApiQuota(usedQuota, display),
    total: displayKnownNewApiQuota(totalQuota, display),
  };
}

export function parseJianzhileTokenPayload(payload, display = DEFAULT_KNOWN_NEW_API_DISPLAY) {
  return parseKnownNewApiTokenPayload(payload, display, '简直了');
}

export function parseFreelyTokenPayload(payload, display = DEFAULT_KNOWN_NEW_API_DISPLAY) {
  return parseKnownNewApiTokenPayload(payload, display, 'freely');
}

function parseKnownNewApiAccountPayload(payload, display, providerLabel) {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.success !== true || !data) throw new Error(String(root?.message || `${providerLabel}账户额度响应缺少 success/data`));
  const remainingQuota = schemaNumber(data.quota, 'quota');
  const usedQuota = schemaNumber(data.used_quota, 'used_quota');
  return {
    remaining: displayKnownNewApiQuota(remainingQuota, display),
    used: displayKnownNewApiQuota(usedQuota, display),
    total: displayKnownNewApiQuota(remainingQuota + usedQuota, display),
  };
}

function normalizedNewApiKey(value) {
  return String(value || '').trim().replace(/^sk-/i, '');
}

function maskedNewApiKeyMatches(value, apiKey) {
  const candidate = normalizedNewApiKey(value);
  const expected = normalizedNewApiKey(apiKey);
  if (!candidate || !expected) return false;
  if (!candidate.includes('*')) return candidate === expected;
  const firstMask = candidate.indexOf('*');
  const lastMask = candidate.lastIndexOf('*');
  const prefix = candidate.slice(0, firstMask);
  const suffix = candidate.slice(lastMask + 1);
  return prefix.length >= 2 && suffix.length >= 2 && expected.startsWith(prefix) && expected.endsWith(suffix);
}

function newApiAccountKeyOwnership(payload, apiKey, providerLabel) {
  const root = record(payload);
  const data = root?.data;
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data)
        ? data.data
        : null;
  if (root?.success !== true || !items) {
    throw new Error(String(root?.message || `${providerLabel}账号 API Key 列表响应格式无效`));
  }
  const candidates = items.map(item => record(item)?.key);
  const total = Number(record(data)?.total ?? root?.total);
  return {
    ownsKey: candidates.some(candidate => maskedNewApiKeyMatches(candidate, apiKey)),
    emptyList: items.length === 0 && (!Number.isFinite(total) || total === 0),
  };
}

export function parseJianzhileAccountPayload(payload, display = DEFAULT_KNOWN_NEW_API_DISPLAY) {
  return parseKnownNewApiAccountPayload(payload, display, '简直了');
}

export function parseFreelyAccountPayload(payload, display = DEFAULT_KNOWN_NEW_API_DISPLAY) {
  return parseKnownNewApiAccountPayload(payload, display, 'freely');
}

function authenticationFailure(status, payload, raw = {}) {
  if (raw?.loginRequired === true) return true;
  if (Number(status) === 401 && payload && typeof payload === 'object') return true;
  const message = String(payload?.message || payload?.error || raw?.message || '');
  return /(?:未登录|请.{0,8}登录|登录.{0,8}(?:失效|过期)|not\s+(?:logged|signed)\s+in|unauthori[sz]ed|authentication\s+required|login\s+required|invalid\s+session)/i.test(message);
}

function interactiveWafFailure(status, payload, raw = {}) {
  if (raw?.cfMitigated === true || raw?.interactivePage === true) return true;
  const text = String(payload?.message || payload?.error || raw?.text || raw?.error || raw?.message || '');
  if (Number(status) === 403) return true;
  if (payload && typeof payload === 'object') return false;
  return /(?:cloudflare|challenge|just a moment|attention required|enable javascript|captcha|waf)/i.test(text);
}

function openAiWhamFailure(result, browserError = null, missingCredentials = false) {
  const status = Number(result?.status) || 0;
  const payload = result?.payload;
  const payloadError = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
  const detail = String(payloadError || payload?.message || browserError?.message || browserError || '').trim();
  const source = result?.transport === 'edge' ? 'openai_wham_browser' : 'openai_wham';
  const loginRequired = missingCredentials || status === 401 || authenticationFailure(status, payload, result);
  if (loginRequired) {
    return {
      source,
      loginRequired: true,
      message: detail || 'OpenAI 登录已失效，请在 Hub 中重新登录',
    };
  }
  if (interactiveWafFailure(status, payload, result)) {
    return {
      source,
      loginRequired: true,
      websiteLoginRequired: true,
      message: 'OpenAI 官网要求完成 WAF 验证，请点击“去官网认证”，完成后手动刷新',
    };
  }
  const summary = status && status !== 200
    ? `OpenAI 用量接口暂时不可用（HTTP ${status}）`
    : status === 200
      ? 'OpenAI 用量响应缺少有效额度窗口'
      : 'OpenAI 用量查询失败';
  return {
    source,
    loginRequired: false,
    message: detail ? `${summary}：${detail}` : summary,
  };
}

function browserPageUnavailable(message) {
  return /(?:frame with id .*error page|no frame with id|cannot access contents|net::err_|showing error page)/i.test(String(message || ''));
}

function providerApiBase(provider) {
  const value = configuredProviderApiBase(provider);
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !isTrustedHttpUrl(url, provider)) return '';
    return value;
  } catch {
    return '';
  }
}

function configuredProviderApiBase(provider) {
  return String(provider?.apiBaseUrl || provider?.baseUrl || '').trim().replace(/\/+$/, '');
}

function requiredProviderApiBase(provider, fallback = '') {
  const configured = configuredProviderApiBase(provider);
  if (!configured) return fallback;
  const safe = providerApiBase(provider);
  if (!safe) throw new Error('非本地供应商接口必须使用 HTTPS');
  return safe;
}

function usageResult(provider, values) {
  const usage = normalizeUsage(provider, {
    isValid: values.isValid !== false,
    invalidMessage: values.invalidMessage || '',
    planName: values.planName || provider.name,
    remaining: values.remaining,
    used: values.used,
    total: values.total,
    unit: values.unit || '',
    extra: values.extra || '',
    periodLabel: values.periodLabel || '',
    hideTotal: values.hideTotal === true,
  });
  const accountBrowser = String(values.accountBrowser || '').replace(/\s+/g, ' ').trim().slice(0, 64);
  if (accountBrowser) usage.accountBrowser = accountBrowser;
  if (values.providerScopedName === true) {
    Object.defineProperty(usage, PROVIDER_SCOPED_NAME, { value: true });
  }
  return usage;
}

function localUsageFallback(repository, provider, reason, options = {}) {
  let local = { requestCount: 0, totalCost: 0 };
  try {
    local = repository?.getLocalUsage?.(provider.id) || local;
  } catch {}
  const requestCount = Math.max(0, Number(local.requestCount) || 0);
  const totalCost = Math.max(0, Number(local.totalCost) || 0);
  if (requestCount <= 0 && totalCost <= 0) return null;
  const detail = String(reason || '远端余额接口暂时不可用').trim().slice(0, 240);
  const websiteLoginRequired = options.websiteLoginRequired === true;
  return {
    usage: usageResult(provider, {
      planName: `${provider.name} 本地已用估算`,
      remaining: null,
      used: totalCost,
      total: null,
      unit: 'USD',
      extra: `${detail}；请求次数：${requestCount}`,
    }),
    source: 'muyuan_local_usage',
    degraded: true,
    loginRequired: websiteLoginRequired,
    websiteLoginRequired,
    message: `${provider.name}远端查询失败（${detail}），显示本地已用估算（${totalCost.toFixed(6)} USD；请求次数：${requestCount}）`,
  };
}

async function readJsonResponse(response) {
  const text = await readResponseTextLimited(response);
  const payload = parseBrowserJson(text);
  return { status: response.status, payload, text };
}

function combinedSignal(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function abortable(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('请求已取消'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('请求已取消'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function abortableDelay(delayMs, signal) {
  const duration = Math.max(0, Number(delayMs) || 0);
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('请求已取消'));
  if (duration === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || new Error('请求已取消'));
    const timer = setTimeout(() => finish(resolve), duration);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function sharedJsonRequestKey(url, headers = {}) {
  const normalizedHeaders = Object.entries(headers || {})
    .filter(([name]) => String(name).toLowerCase() !== 'user-agent')
    .map(([name, value]) => [String(name).toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256')
    .update(JSON.stringify([String(url), normalizedHeaders]))
    .digest('base64url');
}

export async function fetchJson(fetchImpl, url, headers, timeoutMs = 40_000, attempts = 2, externalSignal = null, retryDelayMs = 500, requestCache = null) {
  const responses = requestCache?.responses instanceof Map
    ? requestCache.responses
    : requestCache instanceof Map
      ? requestCache
      : null;
  if (responses) {
    const key = sharedJsonRequestKey(url, headers);
    let operation = responses.get(key);
    if (!operation) {
      operation = fetchJson(
        fetchImpl,
        url,
        headers,
        timeoutMs,
        attempts,
        requestCache?.signal || externalSignal,
        retryDelayMs,
        null,
      );
      responses.set(key, operation);
    }
    return abortable(operation, externalSignal);
  }
  let lastError = null;
  let lastResult = null;
  const maximumAttempts = Math.max(1, Math.trunc(Number(attempts) || 1));
  const totalTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  const deadline = Date.now() + totalTimeoutMs;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    if (externalSignal?.aborted) throw externalSignal.reason || new Error('余额接口请求已取消');
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const attemptsLeft = maximumAttempts - attempt;
    const reservedRetryMs = attemptsLeft > 1 ? Math.min(Math.max(0, retryDelayMs), Math.floor(remainingMs / 4)) : 0;
    const attemptTimeoutMs = Math.max(1, Math.floor((remainingMs - reservedRetryMs) / attemptsLeft));
    const attemptController = new AbortController();
    const attemptTimer = setTimeout(
      () => attemptController.abort(new Error(`余额接口单次请求超过 ${Math.ceil(attemptTimeoutMs / 1_000)} 秒`)),
      attemptTimeoutMs,
    );
    try {
      const requestSignal = combinedSignal(externalSignal, attemptController.signal);
      const response = await abortable(Promise.resolve().then(() => fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: requestSignal,
      })), requestSignal);
      const result = await abortable(readJsonResponse(response), requestSignal);
      lastResult = result;
      const retryable = [429, 500, 502, 503, 504].includes(result.status);
      if (!retryable || attempt + 1 >= maximumAttempts) return result;
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason || error;
      lastError = error;
      if (attempt + 1 >= maximumAttempts) throw error;
    } finally {
      clearTimeout(attemptTimer);
    }
    const remainingAfterAttemptMs = deadline - Date.now();
    if (remainingAfterAttemptMs <= 1) break;
    await abortableDelay(
      Math.min(Math.max(0, retryDelayMs), remainingAfterAttemptMs - 1),
      externalSignal,
    );
  }
  if (lastResult) return lastResult;
  throw lastError || new Error(`余额接口请求超过 ${Math.ceil(totalTimeoutMs / 1_000)} 秒`);
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function accountIdFromSession(session, accessToken) {
  if (session?.account?.id) return String(session.account.id);
  if (session?.account_id) return String(session.account_id);
  const payload = decodeJwtPayload(accessToken);
  const auth = payload['https://api.openai.com/auth'] || {};
  return String(auth.chatgpt_account_id || payload.chatgpt_account_id || '');
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}

function windowLabel(seconds, fallback) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value && value % 86_400 === 0) return value === 86_400 ? '24小时' : `${value / 86_400}天`;
  if (value && value % 3_600 === 0) return `${value / 3_600}小时`;
  return fallback;
}

function isWhamWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usedPercent = finiteOrNull(value.used_percent);
  const windowSeconds = finiteOrNull(value.limit_window_seconds);
  return usedPercent !== null
    && usedPercent >= 0
    && usedPercent <= 100
    && windowSeconds !== null
    && windowSeconds > 0;
}

export function summarizeWham(payload) {
  if (!isWhamUsagePayload(payload)) throw new Error('OpenAI 用量响应缺少有效额度窗口');
  const rateLimit = payload?.rate_limit || {};
  const limits = [];
  for (const [id, fallback] of [['primary', '主窗口'], ['secondary', '次窗口']]) {
    const window = rateLimit[`${id}_window`];
    if (!isWhamWindow(window)) continue;
    const used = Math.max(0, Math.min(100, Number(window.used_percent) || 0));
    const seconds = Math.max(0, Number(window.limit_window_seconds) || 0);
    limits.push({
      id,
      label: windowLabel(seconds, fallback),
      used,
      remaining: Math.max(0, 100 - used),
      total: 100,
      unit: '%',
      resetAfterSeconds: Math.max(0, Number(window.reset_after_seconds) || 0),
      resetAt: window.reset_at || null,
    });
  }
  const primary = limits[0] || { used: 0, remaining: 100 };
  return {
    plan: String(payload?.plan_type || 'OpenAI'),
    used: primary.used,
    remaining: primary.remaining,
    limits,
    creditBalance: payload?.credits?.balance ?? null,
    limitReached: Boolean(rateLimit.limit_reached),
  };
}

export function isWhamUsagePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const rateLimit = payload.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) return false;
  return ['primary_window', 'secondary_window'].some(key => {
    return isWhamWindow(rateLimit[key]);
  });
}

function providerHostnames(provider) {
  const values = [provider?.apiBaseUrl, provider?.baseUrl, provider?.websiteUrl];
  const hosts = [];
  for (const value of values) {
    try {
      const hostname = new URL(String(value || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (hostname && !hosts.includes(hostname)) hosts.push(hostname);
    } catch {}
  }
  return hosts;
}

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hasProviderDomain(provider, ...domains) {
  return providerHostnames(provider).some(hostname => domains.some(domain => hostnameMatches(hostname, domain)));
}

function configuredProviderApiHostname(provider) {
  try {
    return new URL(configuredProviderApiBase(provider)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function hasProviderApiDomain(provider, ...domains) {
  const hostname = configuredProviderApiHostname(provider);
  return Boolean(hostname && domains.some(domain => hostnameMatches(hostname, domain)));
}

function hasLoopbackProviderBase(provider) {
  return ['127.0.0.1', 'localhost', '::1'].includes(configuredProviderApiHostname(provider));
}

function paidMirrorFamily(provider) {
  const hostname = configuredProviderApiHostname(provider);
  return hostname && ['rawchat.cn', 'sharedchat.top'].some(domain => hostnameMatches(hostname, domain))
    ? 'rawchat-sharedchat'
    : '';
}

export function providerKind(provider) {
  const name = String(provider?.name || '').toLowerCase().replace(/\s+/g, '');
  const hasOpenAiCredentials = Boolean(provider?.auth?.tokens?.account_id && provider?.auth?.tokens?.access_token);
  if (hasProviderApiDomain(provider, 'agentrouter.org')) return 'agentrouter';
  if (hasProviderApiDomain(provider, 'anyrouter.top') || configuredProviderApiHostname(provider) === 'a-ocnfniawgw.cn-shanghai.fcapp.run') return 'anyrouter';
  if (hasProviderDomain(provider, 'chatgpt.com') || (name.includes('openai') && hasOpenAiCredentials)) return 'openai';
  if (configuredProviderApiHostname(provider) === 'jianzhile.vip') return 'jianzhile';
  if (configuredProviderApiHostname(provider) === 'free.lyclaude.site') return 'freely';
  if (configuredProviderApiHostname(provider) === 'muyuan.do') return 'muyuan';
  if (configuredProviderApiHostname(provider) === 'welfare.0xpsyche.me') return 'welfare';
  if (hasProviderApiDomain(provider, 'mofas.one')) return 'mofa';
  if (hasProviderApiDomain(provider, 'packyapi.com')) return 'packy';
  if (hasProviderApiDomain(provider, 'deepseek.com') || (name.includes('deepseek') && Boolean(providerApiBase(provider)))) return 'deepseek';
  if (hasProviderApiDomain(provider, 'rawchat.cn', 'sharedchat.top') || name.includes('付费站')) return 'paid';
  if (name.includes('cpa') && hasLoopbackProviderBase(provider)) return 'cpa';
  if (hasProviderDomain(provider, 'chybenzun.top') || name.includes('chy')) return 'health';
  return 'generic';
}

export function defaultBalanceTemplateId(provider) {
  switch (providerKind(provider)) {
    case 'anyrouter':
    case 'agentrouter':
      return 'new-api-browser-account';
    case 'jianzhile':
    case 'freely':
    case 'muyuan':
    case 'welfare':
    case 'mofa':
      return 'new-api-key-quota';
    case 'openai':
      return 'openai-wham';
    case 'cpa':
      return 'cpa-local';
    case 'deepseek':
      return 'deepseek-balance';
    case 'packy':
      return 'packy-balance';
    case 'paid':
      return 'window-balance';
    default:
      return 'api-health-local';
  }
}

function resolvedBalanceTemplateId(provider, templateId = '') {
  const requested = String(templateId || '');
  return getBalanceTemplate(requested) ? requested : defaultBalanceTemplateId(provider);
}

export function loginConfiguration(provider, templateId = '') {
  const selected = resolvedBalanceTemplateId(provider, templateId);
  if (selected === 'openai-wham') {
    return { baseUrl: 'https://chatgpt.com', loginUrl: 'https://chatgpt.com/auth/login', requestPath: '/api/auth/session', navigateRequest: false };
  }
  if (!['new-api-key-quota', 'new-api-browser-account'].includes(selected)) return null;
  switch (providerKind(provider)) {
    case 'anyrouter':
      return { baseUrl: 'https://anyrouter.top', loginUrl: 'https://anyrouter.top/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'agentrouter':
      return { baseUrl: 'https://agentrouter.org', loginUrl: 'https://agentrouter.org/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'jianzhile':
      return { baseUrl: 'https://jianzhile.vip', loginUrl: 'https://jianzhile.vip/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'freely':
      return { baseUrl: 'https://free.lyclaude.site', loginUrl: 'https://free.lyclaude.site/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'muyuan':
      return { baseUrl: 'https://muyuan.do', loginUrl: 'https://muyuan.do/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'welfare':
      return { baseUrl: 'https://welfare.0xpsyche.me', loginUrl: 'https://welfare.0xpsyche.me/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    default: {
      const origin = normalizeProviderTemplateOrigin(provider);
      if (!origin || !origin.startsWith('https://')) return null;
      return { baseUrl: origin, loginUrl: `${origin}/login`, requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    }
  }
}

function safeRequestUrl(baseUrl, requestPath) {
  try {
    const base = new URL(String(baseUrl || ''));
    if (!['https:', 'http:'].includes(base.protocol)) return '';
    base.username = '';
    base.password = '';
    base.search = '';
    base.hash = '';
    const suffix = String(requestPath || '').trim();
    const url = suffix
      ? new URL(`${base.href.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`)
      : base;
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function describeProviderQuery(provider, templateId = '') {
  const kind = providerKind(provider);
  const selected = resolvedBalanceTemplateId(provider, templateId);
  const apiBaseUrl = providerApiBase(provider);
  const origin = normalizeProviderTemplateOrigin(provider);
  const common = { templateId: selected, method: 'GET', waf: false, requiresBrowser: false, notes: [] };
  if (selected === 'new-api-browser-account') {
    const config = loginConfiguration(provider, selected);
    return {
      ...common,
      type: 'browser-cookie',
      label: '现有浏览器 Cookie / New API 账户额度',
      requestUrl: safeRequestUrl(config?.baseUrl, config?.requestPath),
      authentication: `当前浏览器 Cookie${config?.userHeader ? ` + 扩展本地保存的数字用户 ID（${config.userHeader}）` : ''}`,
      executor: 'Edge/Chrome 余额伴侣，同源页面请求',
      waf: true,
      requiresBrowser: true,
      notes: [
        'Cookie 原文保留在当前浏览器，不回传到 Balance Hub',
        'WAF 或登录失败时只显示“去官网认证”，必须由用户手动触发',
      ],
    };
  }
  if (selected === 'new-api-key-quota') {
    const labels = {
      jianzhile: '简直了', freely: 'freely', muyuan: '君的公益', welfare: '无名公益站', mofa: '魔方公益站',
    };
    const label = labels[kind] || provider.name || 'New API';
    const browserFallbackAllowed = origin.startsWith('https://');
    return {
      ...common,
      type: 'api-key-with-account-fallback',
      label: `${label} API Key / 账户总额度`,
      requestUrl: safeRequestUrl(origin, '/api/usage/token/'),
      authentication: browserFallbackAllowed
        ? `有限 Key 使用 Bearer API Key，无需官网登录；无限 Key 使用 ${label} 官网登录态`
        : '有限 Key 使用 Bearer API Key；该 HTTP 例外不使用浏览器登录态',
      executor: browserFallbackAllowed
        ? '有限 Key 直接查询；WAF 或无限 Key 时由 Edge/Chrome 浏览器伴侣执行同源查询'
        : 'Balance Hub 本机宿主直接查询；HTTP 例外不进入浏览器伴侣',
      waf: browserFallbackAllowed,
      notes: [
        '有限 API Key 显示 Key 自身额度；无限 API Key 不显示占位额度',
        browserFallbackAllowed
          ? '浏览器回退只访问 CCSwitch 配置的同一 HTTPS Origin'
          : 'HTTP 例外只匹配本机允许列表中的供应商 ID 与精确 Origin',
        'Cookie 和 Token 原文不进入 Hub 页面',
      ],
    };
  }
  if (selected === 'openai-wham') {
    return {
      ...common,
      type: 'openai-account',
      label: 'OpenAI 账户额度查询',
      requestUrl: WHAM_URL,
      authentication: '本机 OpenAI 账户 Token + ChatGPT-Account-Id',
      executor: 'Node 官方接口；网络/WAF 失败时使用已配对的现有浏览器',
      waf: true,
      notes: ['Token 只在本机内存和已配对浏览器任务中使用，不进入 Hub 页面'],
    };
  }
  if (selected === 'cpa-local') {
    return {
      ...common,
      type: 'local-accounts',
      label: 'CLIProxyAPI 本地账号汇总',
      requestUrl: WHAM_URL,
      authentication: '读取 ~/.cli-proxy-api 中的 Codex 账号 Token',
      executor: '逐账号查询 OpenAI 用量并汇总',
      waf: true,
      notes: ['账号文件只读；失败时可使用已配对的现有浏览器执行同源请求'],
    };
  }
  if (selected === 'deepseek-balance') {
    const deepSeekOrigin = origin || (kind === 'deepseek' ? 'https://api.deepseek.com' : '');
    return {
      ...common,
      type: 'api-key',
      label: kind === 'deepseek' ? 'DeepSeek 官方余额 API' : 'DeepSeek 余额响应模板',
      requestUrl: safeRequestUrl(deepSeekOrigin, '/user/balance'),
      authentication: 'Bearer API Key；无需官网登录',
      executor: 'Balance Hub 直接请求 CCSwitch 配置的供应商 Origin',
    };
  }
  if (selected === 'packy-balance') {
    return {
      ...common,
      type: 'api-key-effective-quota',
      label: kind === 'packy' ? 'PackyCode（New API 扩展）有效额度' : 'New API 重置周期有效额度',
      requestUrl: safeRequestUrl(origin, '/api/usage/token/'),
      authentication: 'Bearer API Key；有限或无限 Key 均无需官网登录',
      executor: 'Balance Hub 直接请求 CCSwitch 配置的供应商 Origin',
      notes: [
        '仅当响应同时提供 total_available、total_used 与 quota_reset_period 时采用此口径',
        'unlimited_quota=true 时显示站点扩展接口返回的有效额度，不转为账户总额度',
      ],
    };
  }
  if (selected === 'window-balance') {
    return {
      ...common,
      type: 'api-key',
      label: '第三方窗口额度 API',
      requestUrl: safeRequestUrl(apiBaseUrl, '/user/balance'),
      authentication: 'Bearer API Key；无需官网登录',
      executor: 'Balance Hub 直接请求 CCSwitch 配置的供应商 Origin',
      notes: ['读取 3 小时与 1 天窗口；相同 API Key 的镜像站复用一次查询结果'],
    };
  }
  return {
    ...common,
    type: 'api-health',
    label: 'API Key 能力检查与本地统计',
    requestUrl: safeRequestUrl(apiBaseUrl, '/models'),
    authentication: 'Bearer API Key；无需官网登录',
    executor: 'Balance Hub 检查模型 API；余额不可用时显示 CCSwitch 本地费用',
    notes: ['该模板不把模型列表成功误判为远端余额接口'],
  };
}

export function providerAliases(provider) {
  const kind = providerKind(provider);
  const name = String(provider.name || '').toLowerCase();
  const aliases = [provider.id, provider.name];
  if (kind === 'anyrouter') aliases.push(name.includes('国内') ? 'anyrouter_cn' : 'anyrouter');
  if (kind === 'agentrouter') aliases.push('agentrouter');
  if (kind === 'openai') aliases.push(name.includes('我自己的') ? 'openai_personal' : 'openai_official');
  if (kind === 'jianzhile') aliases.push('jianzhile');
  if (kind === 'freely') aliases.push('freely');
  if (kind === 'muyuan') aliases.push('muyuan');
  if (kind === 'welfare') aliases.push('welfare');
  if (kind === 'packy') aliases.push('packycode');
  if (kind === 'deepseek') aliases.push('deepseek');
  if (kind === 'paid') aliases.push(name.includes('copy') ? 'paid_sharedchat' : 'paid_rawchat');
  if (kind === 'cpa') aliases.push('cpa');
  if (kind === 'health') aliases.push('chy');
  return [...new Set(aliases.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

export class ProviderQueryEngine {
  constructor(repository, browserBroker, options = {}) {
    this.repository = repository;
    this.browserBroker = browserBroker;
    this.fetchImpl = options.fetchImpl || fetch;
    this.homeDir = options.homeDir || getHomeDir();
    this.now = options.now || Date.now;
    this.whamBrowserProbeTimeoutMs = Math.max(1, Number(options.whamBrowserProbeTimeoutMs) || WHAM_BROWSER_PROBE_TIMEOUT_MS);
    this.whamBrowserRaceDelayMs = Math.max(1, Number(options.whamBrowserRaceDelayMs) || WHAM_BROWSER_RACE_DELAY_MS);
    this.whamDirectBackoffMs = Math.max(1, Number(options.whamDirectBackoffMs) || WHAM_DIRECT_BACKOFF_MS);
    this.whamResultCacheMs = Math.max(1, Number(options.whamResultCacheMs) || WHAM_RESULT_CACHE_MS);
    this.providerQueryTimeoutMs = Math.max(1, Number(options.providerQueryTimeoutMs) || PROVIDER_QUERY_TIMEOUT_MS);
    this.whamDirectRetryAt = 0;
    this.whamInFlight = new Map();
    this.whamRecent = new Map();
    this.inFlightQueries = new Map();
    this.recentQueries = new Map();
  }

  async query(provider, options = {}) {
    const externalSignal = options.signal;
    if (externalSignal?.aborted) throw externalSignal.reason || new Error('供应商余额查询已取消');
    const accountBinding = options?.accountBinding || null;
    const allowSoleSessionFallback = options?.allowSoleSessionFallback !== false;
    const balanceTemplateId = resolvedBalanceTemplateId(provider, options.balanceTemplateId);
    const bypassCache = options.bypassCache === true;
    const cacheKey = bypassCache ? '' : this.#sharedQueryKey(provider, balanceTemplateId, accountBinding, allowSoleSessionFallback);
    const cached = cacheKey ? this.recentQueries.get(cacheKey) : null;
    if (cached && Date.now() - cached.createdAt < 30_000) return this.#copyResult(cached.result, provider);
    if (!cacheKey) {
      return this.#copyResult(await this.#queryWithDeadline(
        provider,
        balanceTemplateId,
        accountBinding,
        allowSoleSessionFallback,
        options.timeoutMs,
        externalSignal,
        options.requestCache,
      ), provider);
    }

    let entry = this.inFlightQueries.get(cacheKey);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, consumers: 0, settled: false, promise: null };
      entry.promise = this.#queryWithDeadline(
        provider,
        balanceTemplateId,
        accountBinding,
        allowSoleSessionFallback,
        options.timeoutMs,
        controller.signal,
        options.requestCache,
      ).then(result => {
        if (result?.usage) this.recentQueries.set(cacheKey, { result, createdAt: Date.now() });
        return result;
      }).finally(() => {
        entry.settled = true;
        if (this.inFlightQueries.get(cacheKey) === entry) this.inFlightQueries.delete(cacheKey);
      });
      entry.promise.catch(() => {});
      this.inFlightQueries.set(cacheKey, entry);
    }
    entry.consumers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (!entry.settled && entry.consumers === 0) {
        entry.controller.abort(externalSignal?.reason || new Error('供应商余额查询已取消'));
      }
    };
    try {
      const result = await abortable(entry.promise, externalSignal);
      return this.#copyResult(result, provider);
    } finally {
      release();
      const cutoff = Date.now() - 30_000;
      for (const [key, item] of this.recentQueries) {
        if (item.createdAt < cutoff) this.recentQueries.delete(key);
      }
    }
  }

  async #queryWithDeadline(provider, balanceTemplateId, accountBinding = null, allowSoleSessionFallback = true, requestedTimeoutMs = 0, externalSignal = null, requestCache = null) {
    if (externalSignal?.aborted) throw externalSignal.reason || new Error('供应商余额查询已取消');
    const controller = new AbortController();
    const signal = combinedSignal(controller.signal, externalSignal);
    const timeoutMs = Math.max(1, Number(requestedTimeoutMs) || this.providerQueryTimeoutMs);
    const timeoutError = new Error(`供应商余额查询超过 ${Math.ceil(timeoutMs / 1_000)} 秒`);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        abortable(
          this.#queryUncached(provider, balanceTemplateId, signal, accountBinding, allowSoleSessionFallback, requestCache),
          signal,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #sharedQueryKey(provider, balanceTemplateId, accountBinding = null, allowSoleSessionFallback = true) {
    const kind = providerKind(provider);
    if (['openai-wham', 'cpa-local'].includes(balanceTemplateId)) return '';
    if (balanceTemplateId === 'new-api-browser-account') {
      const accountIdentity = kind === 'anyrouter'
        ? String(provider.apiKey || provider.id || '')
        : `${providerApiBase(provider)}\0${String(provider.apiKey || provider.id || '')}`;
      const bindingIdentity = kind === 'anyrouter' && accountBinding
        ? `${String(accountBinding.clientRef || '')}\0${String(accountBinding.accountRef || '')}`
        : allowSoleSessionFallback ? 'auto' : 'binding-required';
      return `browser:${balanceTemplateId}:${kind}:${crypto.createHash('sha256').update(accountIdentity).update('\0').update(bindingIdentity).digest('base64url')}`;
    }
    const paidFamily = balanceTemplateId === 'window-balance' && kind === 'paid'
      ? paidMirrorFamily(provider)
      : '';
    const baseIdentity = paidFamily
      ? `paid-mirror:${paidFamily}`
      : providerApiBase(provider);
    const material = [balanceTemplateId, baseIdentity, provider.apiKey].join('\0');
    return crypto.createHash('sha256').update(material).digest('base64url');
  }

  #copyResult(result, provider) {
    if (!result?.usage) return result;
    return {
      ...result,
      usage: {
        ...result.usage,
        providerId: provider.id,
        providerName: result.usage[PROVIDER_SCOPED_NAME] ? provider.name : result.usage.providerName,
        websiteUrl: provider.websiteUrl,
      },
    };
  }

  async #queryUncached(provider, balanceTemplateId, signal, accountBinding = null, allowSoleSessionFallback = true, requestCache = null) {
    if (balanceTemplateId === 'new-api-browser-account') {
      return this.#queryWebProvider(provider, balanceTemplateId, signal, accountBinding, allowSoleSessionFallback);
    }
    if (balanceTemplateId === 'new-api-key-quota') return this.#queryConfiguredNewApi(provider, signal, requestCache);
    if (balanceTemplateId === 'openai-wham') return this.#queryOpenAi(provider, signal);
    if (balanceTemplateId === 'cpa-local') return this.#queryCpa(provider, signal);
    if (balanceTemplateId === 'deepseek-balance') return this.#queryDeepSeek(provider, signal, requestCache);
    if (balanceTemplateId === 'packy-balance') return this.#queryPacky(provider, signal, requestCache);
    if (balanceTemplateId === 'window-balance') return this.#queryPaid(provider, signal, requestCache);
    if (balanceTemplateId === 'api-health-local' && provider.apiKey && configuredProviderApiBase(provider)) {
      return this.#queryHealth(provider, signal, requestCache);
    }
    throw new Error('该供应商没有可用于所选模板的 API Key 或 Base URL');
  }

  async bindBrowserAccount(provider, options = {}) {
    if (providerKind(provider) !== 'anyrouter') throw new Error('只有 AnyRouter 支持显式浏览器账号绑定');
    const config = loginConfiguration(provider);
    const clientRef = String(options.clientRef || '').trim();
    if (!clientRef) throw new Error('请选择要绑定的 Edge 或 Chrome');
    if (
      typeof this.browserBroker?.listQueryClients !== 'function'
      || typeof this.browserBroker?.queryJsonOnClient !== 'function'
    ) {
      return {
        failure: {
          source: 'browser_session',
          loginRequired: true,
          sessionSyncRequired: true,
          message: '余额伴侣版本不支持 AnyRouter 账号绑定，请在 Chrome 和 Edge 中重新加载当前伴侣',
        },
      };
    }
    const client = this.browserBroker.listQueryClients(config.baseUrl)
      .find(candidate => String(candidate.clientRef || candidate.clientId || '') === clientRef);
    if (!client) {
      return {
        failure: {
          source: 'browser_session',
          loginRequired: true,
          sessionSyncRequired: true,
          message: '指定的浏览器余额伴侣当前未连接，无法绑定 AnyRouter 账号',
        },
      };
    }
    const probe = await this.#probeNewApiAccount(client, config, undefined, parseNewApiBalancePayload);
    if (probe.kind !== 'account') {
      return { failure: this.#newApiAccountProbeFailure(probe, 'AnyRouter', String(client.browser || 'Chromium')) };
    }
    if (!probe.accountId) {
      return {
        failure: {
          source: 'browser_session',
          loginRequired: true,
          sessionSyncRequired: true,
          message: `无法取得 ${String(client.browser || 'Chromium')} 中 AnyRouter 账号的稳定用户 ID，请先在该浏览器重新验证官网会话`,
        },
      };
    }
    const origin = new URL(config.baseUrl).origin;
    return {
      binding: {
        clientRef,
        browser: String(client.browser || 'Chromium'),
        origin,
        accountRef: anyRouterAccountRef(origin, clientRef, probe.accountId),
        boundAt: new Date(this.now()).toISOString(),
      },
    };
  }

  async openLogin(provider, options = {}) {
    const balanceTemplateId = resolvedBalanceTemplateId(provider, options.balanceTemplateId);
    const config = loginConfiguration(provider, balanceTemplateId);
    if (!config) throw new Error('该供应商不支持网页登录修复');
    if (!this.browserBroker.isConnected()) throw new Error('请先连接现有 Edge/Chrome 的余额伴侣扩展');
    const clients = typeof this.browserBroker.listQueryClients === 'function'
      ? this.browserBroker.listQueryClients(config.baseUrl)
      : [];
    const target = options.clientRef
      ? clients.find(client => client.clientRef === options.clientRef)
      : null;
    if (options.clientRef && !target) throw new Error('指定的浏览器余额伴侣未连接');
    const result = target && typeof this.browserBroker.openLoginOnClient === 'function'
      ? await this.browserBroker.openLoginOnClient(target.clientRef, config)
      : await this.browserBroker.openLogin(config);
    return {
      success: true,
      loginUrl: config.loginUrl,
      synced: result?.synced === true,
      opened: result?.opened === true,
      loginRequired: result?.loginRequired === true,
      browser: target?.browser || '',
      message: String(result?.message || ''),
    };
  }

  async #queryWebProvider(provider, balanceTemplateId, signal, accountBinding = null, allowSoleSessionFallback = true) {
    if (this.browserBroker.isConnected()) {
      return this.#queryBrowserNewApi(provider, balanceTemplateId, signal, accountBinding, allowSoleSessionFallback);
    }
    return {
      source: 'browser_session',
      loginRequired: false,
      message: '现有 Edge/Chrome 的余额伴侣扩展未连接；未执行无余额价值的模型 API 探测',
    };
  }

  async #queryBrowserNewApi(provider, balanceTemplateId, signal, accountBinding = null, allowSoleSessionFallback = true) {
    const kind = providerKind(provider);
    const config = loginConfiguration(provider, balanceTemplateId);
    if (!config) throw new Error('所选 New API 浏览器模板缺少安全的 HTTPS Base URL');
    if (!this.browserBroker.isConnected()) {
      return { source: 'browser_session', loginRequired: false, message: '现有 Edge/Chrome 的余额伴侣扩展未连接' };
    }
    let balance;
    let accountBrowser = '';
    let accountBrowserNote = '';
    const supportsAccountSelection = Boolean(
      provider.apiKey
      && typeof this.browserBroker?.listQueryClients === 'function'
      && typeof this.browserBroker?.queryJsonOnClient === 'function'
    );
    if (supportsAccountSelection) {
      const verified = await this.#queryVerifiedNewApiAccount(
        provider,
        {
          label: kind === 'anyrouter' ? 'AnyRouter' : kind === 'agentrouter' ? 'AgentRouter' : provider.name,
          accountSource: 'browser_session',
          allowSoleSessionFallback: kind === 'anyrouter' && allowSoleSessionFallback,
          accountBinding: kind === 'anyrouter' ? accountBinding : null,
        },
        config,
        signal,
        parseNewApiBalancePayload,
      );
      if (verified.failure) return verified.failure;
      balance = verified.account;
      accountBrowser = verified.browser;
      accountBrowserNote = verified.bound
        ? `已使用绑定的 ${accountBrowser} AnyRouter 账号`
        : verified.sessionOnly
        ? `AnyRouter Token 列表未返回条目；已使用唯一的 ${accountBrowser} 有效会话`
        : `已通过 ${accountBrowser} 核验此 API Key 所属账号`;
    } else {
      let raw;
      try {
        raw = await this.browserBroker.queryJson(
          { ...config, headers: {} },
          { signal },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!browserPageUnavailable(message)) throw error;
        return {
          source: 'browser_session',
          loginRequired: true,
          websiteLoginRequired: true,
          message: `浏览器中的官网页面当前不可用（${message}）；请打开官网登录页完成认证后手动刷新`,
        };
      }
      const payload = parseBrowserJson(raw?.text);
      if (raw?.identityMissing === true) {
        return {
          source: 'browser_session',
          loginRequired: true,
          sessionSyncRequired: true,
          message: '尚未保存该站的数字用户 ID，请点击“同步现有会话”一次',
        };
      }
      if (authenticationFailure(raw?.status, payload, raw)) {
        return {
          source: 'browser_session',
          loginRequired: true,
          websiteLoginRequired: true,
          message: String(raw.message || '现有浏览器登录已失效，请手动前往官网认证'),
        };
      }
      if (interactiveWafFailure(raw?.status, payload, raw)) {
        return {
          source: 'browser_session',
          loginRequired: true,
          websiteLoginRequired: true,
          message: '第三方网站要求完成 WAF 验证，请点击“去官网认证”，完成后手动刷新',
        };
      }
      if (Number(raw?.status) === 0) {
        const detail = String(raw?.error || raw?.message || '未收到第三方网站响应').trim();
        throw new Error(`浏览器查询失败：${detail}`);
      }
      if (!payload) {
        return {
          source: 'browser_session',
          loginRequired: true,
          websiteLoginRequired: true,
          message: String(raw?.error || (raw?.status
            ? `第三方网站返回了非余额页面（HTTP ${raw.status}），可能需要在官网登录或完成 WAF 验证`
            : '第三方网站没有返回余额数据，请打开官网登录页确认登录状态')),
        };
      }
      if (Number(raw?.status) !== 200) throw new Error(String(payload?.message || `第三方网站余额接口返回 HTTP ${Number(raw?.status) || 0}`));
      balance = parseNewApiBalancePayload(payload);
    }
    return {
      usage: usageResult(provider, {
        planName: balance.group || provider.name,
        providerScopedName: !balance.group,
        remaining: balance.remaining,
        used: balance.used,
        total: balance.total,
        unit: 'USD',
        extra: joinedDetails(
          balance.requestCount == null ? '' : `请求次数：${balance.requestCount}`,
          accountBrowserNote,
        ),
        accountBrowser,
      }),
      source: 'browser_session',
      loginRequired: false,
    };
  }

  async #queryJianzhile(provider, signal, requestCache = null) {
    return this.#queryKnownNewApi(provider, signal, {
      label: '简直了',
      apiKeySource: 'jianzhile_api_key',
      accountSource: 'jianzhile_account',
      finiteExtra: '有限 API Key：显示 Key 自身总额度',
      accountExtra: '无限 API Key：显示所属账户总额度',
      verifyAccountOwnership: true,
    }, requestCache);
  }

  async #queryFreely(provider, signal, requestCache = null) {
    return this.#queryKnownNewApi(provider, signal, {
      label: 'freely',
      apiKeySource: 'freely_api_key',
      accountSource: 'freely_account',
      finiteExtra: '',
      accountExtra: '',
      verifyAccountOwnership: true,
    }, requestCache);
  }

  async #queryMuyuan(provider, signal, requestCache = null) {
    return this.#queryKnownNewApi(provider, signal, {
      label: '君的公益',
      apiKeySource: 'muyuan_api_key',
      accountSource: 'muyuan_account',
      browserSource: 'muyuan_browser',
      finiteExtra: '',
      accountExtra: '',
      browserApiFallback: true,
      localUsageFallback: true,
      verifyAccountOwnership: true,
      directTimeoutMs: 8_000,
      directAttempts: 1,
    }, requestCache);
  }

  async #queryWelfare(provider, signal, requestCache = null) {
    return this.#queryKnownNewApi(provider, signal, {
      label: '无名公益站',
      apiKeySource: 'welfare_api_key',
      accountSource: 'welfare_account',
      finiteExtra: '',
      accountExtra: '',
      verifyAccountOwnership: true,
    }, requestCache);
  }

  async #queryConfiguredNewApi(provider, signal, requestCache = null) {
    switch (providerKind(provider)) {
      case 'jianzhile': return this.#queryJianzhile(provider, signal, requestCache);
      case 'freely': return this.#queryFreely(provider, signal, requestCache);
      case 'muyuan': return this.#queryMuyuan(provider, signal, requestCache);
      case 'welfare': return this.#queryWelfare(provider, signal, requestCache);
      default: {
        const browserApiFallback = normalizeProviderTemplateOrigin(provider).startsWith('https://');
        return this.#queryKnownNewApi(provider, signal, {
          label: provider.name || 'New API 供应商',
          apiKeySource: 'new_api_key',
          accountSource: 'new_api_account',
          browserSource: 'new_api_browser',
          finiteExtra: '',
          accountExtra: '',
          browserApiFallback,
          verifyAccountOwnership: browserApiFallback,
          directTimeoutMs: 8_000,
          directAttempts: 1,
          loginConfig: browserApiFallback ? loginConfiguration(provider, 'new-api-key-quota') : null,
        }, requestCache);
      }
    }
  }

  async #queryKnownNewApi(provider, signal, site, requestCache = null) {
    const baseUrl = requiredProviderApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error(`${site.label}没有可用的 API Key 或 Base URL`);
    const origin = new URL(baseUrl).origin;
    const tokenHeaders = {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    };
    const statusHeaders = { Accept: 'application/json' };
    let tokenResponse;
    let statusResponse;
    let browserApiUsed = false;
    if (!site.browserApiFallback) {
      [tokenResponse, statusResponse] = await Promise.all([
        fetchJson(this.fetchImpl, `${origin}/api/usage/token/`, tokenHeaders, 40_000, 2, signal, 500, requestCache),
        fetchJson(this.fetchImpl, `${origin}/api/status`, statusHeaders, 40_000, 2, signal, 500, requestCache),
      ]);
    } else {
      const safeDirectFetch = async (url, headers) => {
        try {
          return { ...await fetchJson(
            this.fetchImpl,
            url,
            headers,
            Math.max(1, Number(site.directTimeoutMs) || 8_000),
            Math.max(1, Number(site.directAttempts) || 1),
            signal,
            500,
            requestCache,
          ), error: null };
        } catch (error) {
          return { status: 0, payload: null, text: '', error };
        }
      };
      [tokenResponse, statusResponse] = await Promise.all([
        safeDirectFetch(`${origin}/api/usage/token/`, tokenHeaders),
        safeDirectFetch(`${origin}/api/status`, statusHeaders),
      ]);
      const needsBrowser = result => result.status === 0 || interactiveWafFailure(result.status, result.payload, {
        text: result.text,
        error: result.error?.message,
      });
      const directWaf = [tokenResponse, statusResponse].some(result => interactiveWafFailure(result.status, result.payload, {
        text: result.text,
        error: result.error?.message,
      }));
      if ([tokenResponse, statusResponse].some(needsBrowser)) {
        const browserAvailable = typeof this.browserBroker?.queryJson === 'function'
          && (typeof this.browserBroker.isConnected !== 'function' || this.browserBroker.isConnected());
        if (!browserAvailable) {
          const directError = [tokenResponse, statusResponse].find(result => result.error)?.error;
          if (directError && !directWaf) throw directError;
          throw new Error(`${site.label}额度接口被 Cloudflare/WAF 拦截；请连接浏览器伴侣后重试`);
        }
        const browserFetch = async (requestPath, headers) => {
          try {
            const raw = await this.browserBroker.queryJson({
              baseUrl: origin,
              requestPath,
              headers,
              navigateRequest: false,
            }, { signal });
            return {
              status: Number(raw?.status) || 0,
              payload: parseBrowserJson(raw?.text),
              text: String(raw?.text || ''),
              error: raw?.error ? new Error(String(raw.error)) : null,
              cfMitigated: raw?.cfMitigated === true,
              interactivePage: raw?.interactivePage === true,
              permissionRequired: raw?.permissionRequired === true,
            };
          } catch (error) {
            return { status: 0, payload: null, text: '', error };
          }
        };
        browserApiUsed = true;
        [tokenResponse, statusResponse] = await Promise.all([
          needsBrowser(tokenResponse) ? browserFetch('/api/usage/token/', tokenHeaders) : tokenResponse,
          needsBrowser(statusResponse) ? browserFetch('/api/status', statusHeaders) : statusResponse,
        ]);
        const browserWaf = [tokenResponse, statusResponse].some(result => interactiveWafFailure(result.status, result.payload, {
          text: result.text,
          error: result.error?.message,
        }));
        if (browserWaf) {
          const fallback = site.localUsageFallback
            ? localUsageFallback(this.repository, provider, '官网要求完成 Cloudflare/WAF 验证', { websiteLoginRequired: true })
            : null;
          if (fallback) return fallback;
          return {
            source: site.browserSource,
            loginRequired: true,
            websiteLoginRequired: true,
            message: `${site.label}官网要求完成 Cloudflare/WAF 验证；请打开官网完成验证后手动刷新`,
          };
        }
        const browserError = [tokenResponse, statusResponse].find(result => result.status === 0 && result.error)?.error;
        if (browserError) {
          const browserPermissionRequired = [tokenResponse, statusResponse].some(result => result.permissionRequired === true);
          const fallback = site.localUsageFallback
            ? localUsageFallback(
                this.repository,
                provider,
                browserPermissionRequired
                  ? '余额伴侣缺少供应商网站查询权限；请打开扩展弹窗并点击“授予网站查询权限”'
                  : '浏览器传输未能取得远端余额',
                { websiteLoginRequired: directWaf && !browserPermissionRequired },
              )
            : null;
          if (fallback) return fallback;
          throw new Error(`${site.label}浏览器查询失败：${browserError instanceof Error ? browserError.message : String(browserError)}`);
        }
      }
    }
    if (tokenResponse.status !== 200) throw new Error(String(tokenResponse.payload?.message || `${site.label} API Key 额度接口返回 HTTP ${tokenResponse.status}`));
    if (statusResponse.status !== 200) throw new Error(String(statusResponse.payload?.message || `${site.label}站点配置接口返回 HTTP ${statusResponse.status}`));
    const display = parseKnownNewApiDisplayPayload(statusResponse.payload, site.label);
    const token = parseKnownNewApiTokenPayload(tokenResponse.payload, display, site.label);
    if (!token.unlimited) {
      return {
        usage: usageResult(provider, {
          planName: `${provider.name} API Key 额度`,
          remaining: token.remaining,
          used: token.used,
          total: token.total,
          unit: display.unit,
          extra: apiKeyDetails(site.finiteExtra),
        }),
        source: browserApiUsed ? site.browserSource : site.apiKeySource,
        loginRequired: false,
      };
    }

    const config = site.loginConfig || loginConfiguration(provider, 'new-api-key-quota');
    if (!config) throw new Error(`${site.label}无法生成安全的 New API 登录配置`);
    if (typeof this.browserBroker?.isConnected !== 'function' || !this.browserBroker.isConnected()) {
      return {
        source: site.accountSource,
        schemaValidated: true,
        loginRequired: true,
        sessionSyncRequired: true,
        message: `${site.label} API Key 为无限额度；请连接并同步 ${site.label} 官网登录态，以读取账户总额度`,
      };
    }

    let account;
    let accountBrowser = '';
    if (site.verifyAccountOwnership) {
      const verified = await this.#queryVerifiedNewApiAccount(
        provider,
        { ...site, unlimitedKey: true },
        config,
        signal,
        payload => parseKnownNewApiAccountPayload(payload, display, site.label),
      );
      if (verified.failure) return verified.failure;
      account = verified.account;
      accountBrowser = verified.browser;
    } else {
      let raw;
      try {
        raw = await this.browserBroker.queryJson({ ...config, headers: {} }, { signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!browserPageUnavailable(message)) throw error;
        return {
          source: site.accountSource,
          loginRequired: true,
          websiteLoginRequired: true,
          message: `${site.label}官网页面当前不可用（${message}）；请登录官网后手动刷新`,
        };
      }
      const accountPayload = parseBrowserJson(raw?.text);
      if (raw?.identityMissing === true) {
        return {
          source: site.accountSource,
          loginRequired: true,
          sessionSyncRequired: true,
          message: `尚未保存 ${site.label} 的纯数字用户 ID，请点击“同步现有会话”一次`,
        };
      }
      if (authenticationFailure(raw?.status, accountPayload, raw)) {
        return {
          source: site.accountSource,
          loginRequired: true,
          websiteLoginRequired: true,
          message: `${site.label}官网登录已失效，请重新登录后手动刷新`,
        };
      }
      if (interactiveWafFailure(raw?.status, accountPayload, raw)) {
        return {
          source: site.accountSource,
          loginRequired: true,
          websiteLoginRequired: true,
          message: `${site.label}官网要求完成 WAF 验证，请在官网完成后手动刷新`,
        };
      }
      if (Number(raw?.status) !== 200 || !accountPayload) {
        throw new Error(String(accountPayload?.message || raw?.error || `${site.label}账户额度接口返回 HTTP ${Number(raw?.status) || 0}`));
      }
      account = parseKnownNewApiAccountPayload(accountPayload, display, site.label);
    }
    const usedCandidates = [account.used, token.used].filter(value => Number.isFinite(value));
    const used = usedCandidates.length ? Math.max(...usedCandidates) : null;
    return {
      usage: usageResult(provider, {
        planName: `${provider.name} 账户总额度`,
        remaining: account.remaining,
        used,
        total: used == null ? account.total : account.remaining + used,
        unit: display.unit,
        extra: [site.accountExtra, accountBrowser ? `已通过 ${accountBrowser} 核验此 API Key 所属账号` : ''].filter(Boolean).join('；'),
        accountBrowser,
      }),
      source: site.accountSource,
      loginRequired: false,
    };
  }

  async #probeNewApiAccount(client, config, signal, parseAccountPayload) {
    try {
      const accountRaw = await this.browserBroker.queryJsonOnClient(
        client.clientRef || client.clientId,
        { ...config, headers: {} },
        { signal },
      );
      const accountPayload = parseBrowserJson(accountRaw?.text);
      if (accountRaw?.identityMissing === true) return { kind: 'identity', client };
      if (authenticationFailure(accountRaw?.status, accountPayload, accountRaw)) return { kind: 'authentication', client };
      if (interactiveWafFailure(accountRaw?.status, accountPayload, accountRaw)) return { kind: 'waf', client };
      if (Number(accountRaw?.status) !== 200 || !accountPayload) {
        return {
          kind: 'error',
          client,
          message: String(accountPayload?.message || accountRaw?.error || `HTTP ${Number(accountRaw?.status) || 0}`),
        };
      }
      return {
        kind: 'account',
        client,
        account: parseAccountPayload(accountPayload),
        accountId: newApiAccountId(accountPayload),
      };
    } catch (error) {
      return { kind: 'error', client, message: error instanceof Error ? error.message : String(error) };
    }
  }

  #newApiAccountProbeFailure(probe, label, browser) {
    const base = { source: 'browser_session', loginRequired: true };
    if (probe.kind === 'identity') {
      return {
        ...base,
        sessionSyncRequired: true,
        message: `请先在 ${browser} 中为 ${label} 点击一次“验证”以同步现有会话`,
      };
    }
    if (probe.kind === 'waf') {
      return {
        ...base,
        websiteLoginRequired: true,
        message: `${browser} 中的 ${label} 官网要求完成 WAF 验证，请完成后重新绑定`,
      };
    }
    if (probe.kind === 'authentication') {
      return {
        ...base,
        websiteLoginRequired: true,
        message: `${browser} 中的 ${label} 官网登录已失效，请重新登录后再绑定`,
      };
    }
    return {
      ...base,
      websiteLoginRequired: true,
      message: `${browser} 中的 ${label} 账号查询失败${probe.message ? `：${probe.message}` : ''}`,
    };
  }

  async #queryVerifiedNewApiAccount(provider, site, config, signal, parseAccountPayload) {
    if (
      typeof this.browserBroker?.listQueryClients !== 'function'
      || typeof this.browserBroker?.queryJsonOnClient !== 'function'
    ) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          sessionSyncRequired: true,
          message: '余额伴侣版本不支持同站多账号隔离，请在 Chrome 和 Edge 中重新加载当前 v2 余额伴侣',
        },
      };
    }
    const clients = this.browserBroker.listQueryClients(config.baseUrl).slice(0, 6);
    if (!clients.length) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          sessionSyncRequired: true,
          message: site.unlimitedKey
            ? `${site.label} API Key 为无限额度；请在对应账号所在浏览器中连接余额伴侣`
            : `${site.label} 需要对应账号的浏览器登录态；请连接余额伴侣`,
        },
      };
    }

    const requestedBinding = site.accountBinding;
    if (requestedBinding) {
      const expectedOrigin = new URL(config.baseUrl).origin;
      const bindingClientRef = String(requestedBinding.clientRef || '').trim();
      const bindingAccountRef = String(requestedBinding.accountRef || '').trim();
      if (
        !bindingClientRef
        || !/^[A-Za-z0-9_-]{43}$/.test(bindingAccountRef)
        || String(requestedBinding.origin || '') !== expectedOrigin
      ) {
        return {
          failure: {
            source: site.accountSource,
            loginRequired: true,
            accountBindingMismatch: true,
            accountBindingRequired: true,
            invalidateUsage: true,
            message: 'AnyRouter 账号绑定已失效，请重新选择 Edge 或 Chrome',
          },
        };
      }
      const client = clients.find(candidate => String(candidate.clientRef || candidate.clientId || '') === bindingClientRef);
      const boundBrowser = String(requestedBinding.browser || client?.browser || 'Chromium');
      if (!client) {
        return {
          failure: {
            source: site.accountSource,
            loginRequired: true,
            sessionSyncRequired: true,
            message: `绑定的 ${boundBrowser} 余额伴侣当前未连接；不会改用其他浏览器账号`,
          },
        };
      }
      const boundProbe = await this.#probeNewApiAccount(client, config, signal, parseAccountPayload);
      if (boundProbe.kind !== 'account') {
        return { failure: { ...this.#newApiAccountProbeFailure(boundProbe, site.label, boundBrowser), source: site.accountSource } };
      }
      if (!boundProbe.accountId) {
        return {
          failure: {
            source: site.accountSource,
            loginRequired: true,
            sessionSyncRequired: true,
            accountBindingRequired: true,
            message: `绑定的 ${boundBrowser} AnyRouter 响应缺少稳定用户 ID，请重新验证并绑定`,
          },
        };
      }
      const actualAccountRef = anyRouterAccountRef(expectedOrigin, bindingClientRef, boundProbe.accountId);
      if (actualAccountRef !== bindingAccountRef) {
        return {
          failure: {
            source: site.accountSource,
            loginRequired: true,
            accountBindingMismatch: true,
            accountBindingRequired: true,
            invalidateUsage: true,
            message: `绑定的 ${boundBrowser} AnyRouter 账号已变化；请重新绑定`,
          },
        };
      }
      return {
        account: boundProbe.account,
        browser: String(client.browser || boundBrowser),
        bound: true,
      };
    }

    const probe = async client => {
      try {
        const accountProbe = await this.#probeNewApiAccount(client, config, signal, parseAccountPayload);
        if (accountProbe.kind !== 'account') return accountProbe;
        const ownershipRaw = await this.browserBroker.queryJsonOnClient(
          client.clientRef || client.clientId,
          { ...config, requestPath: '/api/token/?p=1&size=100', headers: {} },
          { signal },
        );
        const ownershipPayload = parseBrowserJson(ownershipRaw?.text);
        if (ownershipRaw?.identityMissing === true) return { kind: 'identity', client };
        if (authenticationFailure(ownershipRaw?.status, ownershipPayload, ownershipRaw)) return { kind: 'authentication', client };
        if (interactiveWafFailure(ownershipRaw?.status, ownershipPayload, ownershipRaw)) return { kind: 'waf', client };
        if (Number(ownershipRaw?.status) !== 200 || !ownershipPayload) {
          return { kind: 'error', client, message: String(ownershipPayload?.message || ownershipRaw?.error || `HTTP ${Number(ownershipRaw?.status) || 0}`) };
        }
        const ownership = newApiAccountKeyOwnership(ownershipPayload, provider.apiKey, site.label);
        if (ownership.ownsKey) return { kind: 'match', client, account: accountProbe.account };
        if (ownership.emptyList) return { kind: 'empty-list', client, account: accountProbe.account };
        return { kind: 'mismatch', client };
      } catch (error) {
        return { kind: 'error', client, message: error instanceof Error ? error.message : String(error) };
      }
    };

    const hintedClients = clients.filter(client => client.hasSession === true);
    const unhintedClients = clients.filter(client => client.hasSession !== true);
    const results = [];
    const probeClients = async candidates => {
      for (const client of candidates) {
        const result = await probe(client);
        results.push(result);
        if (result.kind === 'match') return result;
      }
      return null;
    };
    let matched = await probeClients(hintedClients.length ? hintedClients : unhintedClients);
    if (
      !matched
      && site.allowSoleSessionFallback === true
      && hintedClients.length === 1
      && results.length === 1
      && results[0].kind === 'empty-list'
    ) {
      const soleSession = results[0];
      return {
        account: soleSession.account,
        browser: String(soleSession.client.browser || 'Chromium'),
        sessionOnly: true,
      };
    }
    if (!matched && hintedClients.length && results.every(result => result.kind === 'mismatch')) {
      matched = await probeClients(unhintedClients);
    }
    if (matched) return { account: matched.account, browser: String(matched.client.browser || 'Chromium') };
    const browserNames = [...new Set(results.map(result => String(result.client.browser || 'Chromium')))];
    const browserLabel = browserNames.join(' / ') || 'Chrome / Edge';
    if (results.length > 0 && results.every(result => result.kind === 'mismatch')) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          websiteLoginRequired: true,
          accountMismatch: true,
          message: `已连接的 ${browserLabel} 登录账号都不包含 ${provider.name} 的 API Key；请在对应账号所在浏览器中连接余额伴侣并同步现有会话`,
        },
      };
    }
    if (results.length > 0 && results.every(result => result.kind === 'empty-list')) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          accountBindingRequired: true,
          message: `${site.label} Token 列表未返回可核验条目；请为 ${provider.name} 明确绑定 Edge 或 Chrome 账号`,
        },
      };
    }
    if (results.some(result => result.kind === 'identity')) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          sessionSyncRequired: true,
          message: `请分别在 ${browserLabel} 中为 ${site.label} 点击一次“同步现有会话”`,
        },
      };
    }
    if (results.some(result => result.kind === 'waf')) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          websiteLoginRequired: true,
          message: `${site.label} 官网要求完成 WAF 验证，请在对应浏览器完成后手动刷新`,
        },
      };
    }
    if (results.some(result => result.kind === 'authentication')) {
      return {
        failure: {
          source: site.accountSource,
          loginRequired: true,
          websiteLoginRequired: true,
          message: `${browserLabel} 中的 ${site.label} 官网登录已失效，请重新登录后手动刷新`,
        },
      };
    }
    const detail = results.map(result => result.message).find(Boolean);
    return {
      failure: {
        source: site.accountSource,
        loginRequired: true,
        websiteLoginRequired: true,
        message: `${provider.name} 无法从已连接的 ${browserLabel} 核验账号${detail ? `：${detail}` : ''}`,
      },
    };
  }

  async #queryDeepSeek(provider, signal, requestCache = null) {
    const origin = normalizeProviderTemplateOrigin(provider)
      || (providerKind(provider) === 'deepseek' ? 'https://api.deepseek.com' : '');
    if (!provider.apiKey || !origin) throw new Error('DeepSeek 模板没有可用的 API Key 或安全 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${origin}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    }, 40_000, 2, signal, 500, requestCache);
    if (status !== 200) throw new Error(String(payload?.message || `DeepSeek 余额接口返回 HTTP ${status}`));
    const balances = parseDeepSeekBalancePayload(payload);
    const remaining = balances.reduce((sum, item) => sum + item.value, 0);
    const currencies = new Set(balances.map(item => item.currency).filter(Boolean));
    return {
      usage: usageResult(provider, {
        planName: 'DeepSeek',
        remaining,
        used: null,
        total: null,
        unit: currencies.size === 1 ? [...currencies][0] : 'currency',
        extra: apiKeyDetails(balances.map(item => `${item.currency}: ${item.value}`).join('，')),
      }),
      source: 'official_api',
      loginRequired: false,
    };
  }

  async #queryPacky(provider, signal, requestCache = null) {
    const origin = normalizeProviderTemplateOrigin(provider);
    if (!provider.apiKey || !origin) throw new Error('New API 重置周期额度模板没有可用的 API Key 或安全 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${origin}/api/usage/token/`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'cc-switch/1.0',
    }, 40_000, 2, signal, 500, requestCache);
    if (status !== 200) throw new Error(String(payload?.message || `New API 重置周期额度接口返回 HTTP ${status}`));
    const balance = parsePackyBalancePayload(payload);
    const quotaMode = balance.unlimited === true
      ? '无限 API Key：按 New API 扩展字段显示有效额度'
      : balance.unlimited === false
        ? '有限 API Key：显示 Key 自身有效额度'
        : 'New API 扩展字段：显示 Key 有效额度';
    return {
      usage: usageResult(provider, {
        planName: `${provider.name} Key 有效额度`,
        providerScopedName: true,
        remaining: balance.remaining,
        used: balance.used,
        total: balance.total,
        unit: 'USD',
        extra: apiKeyDetails(quotaMode, `重置周期：${balance.resetPeriod}`),
      }),
      source: 'provider_api',
      loginRequired: false,
    };
  }

  async #queryPaid(provider, signal, requestCache = null) {
    const baseUrl = requiredProviderApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error('窗口额度模板没有可用的 API Key 或安全 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'codex-ccswitch-usage/2',
    }, 40_000, 2, signal, 500, requestCache);
    if (status !== 200 || !payload || typeof payload !== 'object') throw new Error(`付费站余额接口返回 HTTP ${status}`);
    const balance = parseWindowBalancePayload(payload);
    const short = value => {
      const number = finiteOrNull(value);
      return number == null ? '--' : (Math.trunc(number * 100) / 100).toFixed(2);
    };
    return {
      usage: usageResult(provider, {
        planName: provider.name,
        providerScopedName: true,
        extra: apiKeyDetails(`3H剩:${short(balance.shortWindow.remaining)}`),
        periodLabel: '1D',
        hideTotal: true,
        used: balance.daily.used,
        remaining: balance.daily.remaining,
        total: balance.daily.total,
        unit: balance.unit,
      }),
      source: 'provider_api',
      loginRequired: false,
    };
  }

  async #queryWham(accessToken, accountId, signal) {
    const cacheKey = crypto.createHash('sha256')
      .update(String(accountId))
      .update('\0')
      .update(String(accessToken))
      .digest('base64url');
    const cached = this.whamRecent.get(cacheKey);
    if (cached && this.now() - cached.createdAt < this.whamResultCacheMs) return cached.result;
    if (this.whamInFlight.has(cacheKey)) return this.whamInFlight.get(cacheKey);

    const operation = this.#queryWhamUncached(accessToken, accountId, signal);
    this.whamInFlight.set(cacheKey, operation);
    try {
      const result = await operation;
      if (result?.status === 200 && isWhamUsagePayload(result.payload)) {
        this.whamRecent.set(cacheKey, { result, createdAt: this.now() });
      }
      return result;
    } finally {
      if (this.whamInFlight.get(cacheKey) === operation) this.whamInFlight.delete(cacheKey);
      const cutoff = this.now() - this.whamResultCacheMs;
      for (const [key, item] of this.whamRecent) {
        if (item.createdAt <= cutoff) this.whamRecent.delete(key);
      }
    }
  }

  async #queryWhamUncached(accessToken, accountId, signal) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
      Accept: 'application/json',
      'User-Agent': 'codex-ccswitch-usage/2',
    };
    const browserAvailable = typeof this.browserBroker?.queryJson === 'function'
      && (typeof this.browserBroker.isConnected !== 'function' || this.browserBroker.isConnected());
    const directReady = !browserAvailable || this.now() >= this.whamDirectRetryAt;

    const directController = new AbortController();
    const directPromise = directReady
      ? fetchJson(
        this.fetchImpl,
        WHAM_URL,
        headers,
        browserAvailable ? this.whamBrowserProbeTimeoutMs : 40_000,
        browserAvailable ? 1 : 2,
        combinedSignal(signal, directController.signal),
      ).then(result => ({
        kind: 'direct',
        definitive: isWhamUsagePayload(result.payload)
          || (result.status !== 200 && (Boolean(result.payload) || ![403, 429, 500, 502, 503, 504].includes(result.status))),
        result: { ...result, transport: 'node' },
        error: null,
      }), error => ({ kind: 'direct', definitive: false, result: null, error }))
      : null;

    if (!browserAvailable) {
      const direct = await directPromise;
      if (direct.result) return direct.result;
      throw direct.error || new Error('OpenAI 用量直连失败');
    }

    const browserHeaders = { ...headers };
    delete browserHeaders['User-Agent'];
    let browserController = null;
    let browserPromise = null;
    const startBrowser = () => {
      if (browserPromise) return browserPromise;
      browserController = new AbortController();
      browserPromise = this.browserBroker.queryJson({
        baseUrl: 'https://chatgpt.com',
        requestPath: '/backend-api/wham/usage',
        headers: browserHeaders,
        navigateRequest: false,
      }, { signal: combinedSignal(signal, browserController.signal) }).then(raw => {
        const result = { status: Number(raw?.status) || 0, payload: parseBrowserJson(raw?.text), text: String(raw?.text || ''), transport: 'edge' };
        return { kind: 'browser', definitive: result.status === 200 && isWhamUsagePayload(result.payload), result, error: null };
      }, error => ({ kind: 'browser', definitive: false, result: null, error }));
      return browserPromise;
    };

    const finishWithBrowser = browser => {
      if (!browser.result) return null;
      if (browser.definitive) {
        if (directReady) this.whamDirectRetryAt = this.now() + this.whamDirectBackoffMs;
        directController.abort(new Error('OpenAI WHAM 浏览器请求已先完成'));
      }
      return browser.result;
    };

    if (!directReady) {
      const browser = await startBrowser();
      if (browser.result) return browser.result;
      throw browser.error || new Error('OpenAI 浏览器用量查询失败');
    }

    let delayTimer = null;
    const delayedBrowser = new Promise(resolve => {
      delayTimer = setTimeout(() => resolve({ kind: 'delay' }), this.whamBrowserRaceDelayMs);
    });
    const first = await Promise.race([directPromise, delayedBrowser]);
    if (first.kind === 'direct') {
      clearTimeout(delayTimer);
      if (first.definitive) {
        this.whamDirectRetryAt = 0;
        return first.result;
      }
      const browser = await startBrowser();
      const browserResult = finishWithBrowser(browser);
      if (browserResult) return browserResult;
      if (first.result) return first.result;
      throw first.error || browser.error;
    }

    const browser = startBrowser();
    const winner = await Promise.race([directPromise, browser]);
    if (winner.kind === 'browser') {
      if (winner.definitive) return finishWithBrowser(winner);
      const direct = await directPromise;
      if (direct.definitive) {
        this.whamDirectRetryAt = 0;
        return direct.result;
      }
      const browserResult = finishWithBrowser(winner);
      if (browserResult) return browserResult;
      if (direct.result) return direct.result;
      throw direct.error || winner.error;
    }

    if (winner.definitive) {
      browserController.abort(new Error('OpenAI WHAM 直连请求已先完成'));
      this.whamDirectRetryAt = 0;
      return winner.result;
    }
    const browserResult = finishWithBrowser(await browser);
    if (browserResult) return browserResult;
    if (winner.result) return winner.result;
    throw winner.error || (await browser).error;
  }

  async #queryOpenAi(provider, signal) {
    const tokens = provider.auth?.tokens || {};
    const accountId = String(tokens.account_id || '');
    let accessToken = String(tokens.access_token || '');
    const replacement = this.#findCpaToken(accountId);
    if (replacement?.access_token) accessToken = String(replacement.access_token);
    const missingCredentials = !accessToken || !accountId;
    const result = missingCredentials ? { status: 401, payload: null } : await this.#queryWham(accessToken, accountId, signal);
    if (result.status !== 200 || !isWhamUsagePayload(result.payload)) {
      let browserError = null;
      const browserResult = await this.#queryOpenAiBrowser(provider, signal).catch(error => {
        browserError = error;
        return null;
      });
      if (browserResult) return browserResult;
      if (signal?.aborted) throw signal.reason || browserError || new Error('OpenAI 用量查询已取消');
      return openAiWhamFailure(result, browserError, missingCredentials);
    }
    return this.#openAiUsage(provider, result.payload, result.transport === 'edge' ? 'openai_wham_browser' : 'openai_wham');
  }

  async #queryOpenAiBrowser(provider, signal) {
    if (typeof this.browserBroker?.hasSession !== 'function' || !this.browserBroker.hasSession('https://chatgpt.com')) return null;
    const config = loginConfiguration(provider);
    const configuredAccountId = String(provider.auth?.tokens?.account_id || '');
    let session;
    let accessToken = '';
    let accountId = '';
    let accountBrowser = '';
    const supportsAccountSelection = Boolean(
      typeof this.browserBroker?.listQueryClients === 'function'
      && typeof this.browserBroker?.queryJsonOnClient === 'function'
    );
    if (supportsAccountSelection) {
      const clients = this.browserBroker.listQueryClients(config.baseUrl).slice(0, 6);
      const candidates = await Promise.all(clients.map(async client => {
        try {
          const raw = await this.browserBroker.queryJsonOnClient(
            client.clientRef || client.clientId,
            config,
            { signal },
          );
          if (Number(raw?.status) !== 200) return null;
          const candidateSession = parseBrowserJson(raw?.text);
          const candidateToken = String(candidateSession?.accessToken || candidateSession?.access_token || '');
          const candidateAccountId = accountIdFromSession(candidateSession, candidateToken);
          if (!candidateToken || !candidateAccountId) return null;
          return { client, session: candidateSession, accessToken: candidateToken, accountId: candidateAccountId };
        } catch {
          return null;
        }
      }));
      const valid = candidates.filter(Boolean);
      const matched = configuredAccountId
        ? valid.find(candidate => candidate.accountId === configuredAccountId)
        : valid[0];
      if (!matched) {
        const browserLabel = [...new Set(clients.map(client => String(client.browser || 'Chromium')))].join(' / ') || 'Chrome / Edge';
        return {
          source: 'browser_session',
          loginRequired: true,
          websiteLoginRequired: true,
          message: configuredAccountId
            ? `已连接的 ${browserLabel} 未找到与 ${provider.name} 匹配的 OpenAI 账号`
            : `已连接的 ${browserLabel} 没有可用的 OpenAI 登录账号`,
        };
      }
      ({ session, accessToken, accountId } = matched);
      accountBrowser = String(matched.client.browser || 'Chromium');
    } else {
      const raw = await this.browserBroker.queryJson(config, { signal });
      session = parseBrowserJson(raw?.text);
      accessToken = String(session?.accessToken || session?.access_token || '');
      accountId = accountIdFromSession(session, accessToken);
    }
    if (!accessToken || !accountId) return null;
    const result = await this.#queryWham(accessToken, accountId, signal);
    if (result.status !== 200 || !isWhamUsagePayload(result.payload)) return null;
    return this.#openAiUsage(provider, result.payload, 'browser_session', {
      accountBrowser,
      extra: accountBrowser ? `已通过 ${accountBrowser} 匹配 OpenAI 账号` : '',
    });
  }

  #openAiUsage(provider, payload, source, options = {}) {
    const summary = summarizeWham(payload);
    const details = summary.limits.map(item => {
      const reset = item.resetAfterSeconds ? `，约 ${Math.floor(item.resetAfterSeconds / 60)} 分钟后重置` : '';
      return `${item.label} ${item.remaining.toFixed(1)}% 可用${reset}`;
    });
    if (summary.creditBalance != null) details.push(`Credits ${summary.creditBalance}`);
    if (options.extra) details.push(String(options.extra));
    return {
      usage: usageResult(provider, {
        planName: `OpenAI ${summary.plan}`,
        remaining: summary.remaining,
        used: summary.used,
        total: 100,
        unit: '%',
        extra: details.join('；'),
        accountBrowser: options.accountBrowser,
      }),
      source,
      loginRequired: false,
    };
  }

  #cpaAuthFiles() {
    const directory = path.join(this.homeDir, '.cli-proxy-api');
    let handle;
    try {
      handle = fs.opendirSync(directory);
      const candidates = [];
      for (let scanned = 0; scanned < MAX_CPA_AUTH_DIRECTORY_ENTRIES; scanned += 1) {
        const entry = handle.readSync();
        if (!entry) break;
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
        const filename = path.join(directory, entry.name);
        try {
          const stats = fs.statSync(filename);
          if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_CPA_AUTH_FILE_BYTES) continue;
          candidates.push({ filename, modifiedAt: Number(stats.mtimeMs) || 0 });
        } catch {}
      }
      return candidates
        .sort((left, right) => right.modifiedAt - left.modifiedAt || right.filename.localeCompare(left.filename))
        .slice(0, MAX_CPA_AUTH_FILES)
        .map(item => item.filename);
    } catch {
      return [];
    } finally {
      try { handle?.closeSync(); } catch {}
    }
  }

  #readCpaAuth(filename) {
    try {
      const stats = fs.statSync(filename);
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_CPA_AUTH_FILE_BYTES) return null;
      const auth = JSON.parse(fs.readFileSync(filename, 'utf8'));
      return auth?.type === 'codex' ? auth : null;
    } catch {
      return null;
    }
  }

  #findCpaToken(accountId) {
    if (!accountId) return null;
    const candidates = this.#cpaAuthFiles()
      .map(filename => ({ filename, auth: this.#readCpaAuth(filename) }))
      .filter(item => String(item.auth?.account_id || '') === accountId)
      .map(item => {
        try { return { ...item, modifiedAt: fs.statSync(item.filename).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    return candidates[0]?.auth || null;
  }

  async #queryCpa(provider, signal) {
    const accounts = this.#cpaAuthFiles().map(filename => ({
      label: path.basename(filename, path.extname(filename)),
      auth: this.#readCpaAuth(filename),
    })).filter(item => item.auth?.access_token && item.auth?.account_id);
    const results = await mapWithConcurrency(accounts, 3, async item => {
      const result = await this.#queryWham(String(item.auth.access_token), String(item.auth.account_id), signal).catch(() => ({ status: 0, payload: null }));
      return {
        label: item.label,
        enabled: !item.auth.disabled,
        summary: result.status === 200 && isWhamUsagePayload(result.payload) ? summarizeWham(result.payload) : null,
      };
    });
    const successful = results.filter(item => item.summary);
    const usable = successful.filter(item => item.enabled);
    const selected = usable.length ? usable : successful;
    if (!selected.length) return { source: 'cpa_auth_files', loginRequired: true, message: 'CLIProxyAPI 没有可查询的 Codex 账号' };
    const remaining = Math.min(...selected.map(item => item.summary.remaining));
    const used = Math.max(...selected.map(item => item.summary.used));
    const extra = successful.map(item => `${item.label}: ${item.summary.remaining.toFixed(1)}% 可用${item.enabled ? '' : '（已停用）'}`).join('；');
    return {
      usage: usageResult(provider, { planName: `CLIProxyAPI（${selected.length} 个可用账号）`, remaining, used, total: 100, unit: '%', extra }),
      source: 'cpa_auth_files',
      loginRequired: false,
    };
  }

  async #queryHealth(provider, signal, requestCache = null) {
    const baseUrl = requiredProviderApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error('该站没有可用于健康检查的 API Key 或 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/models`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    }, 40_000, 2, signal, 500, requestCache);
    let local = { requestCount: 0, totalCost: 0 };
    try { local = this.repository.getLocalUsage(provider.id); } catch {}
    const valid = status === 200 && payload && Array.isArray(payload.data);
    const message = valid ? 'API Key 可用；该站未提供余额接口，已用为 CCSwitch 本地记录费用' : String(payload?.error?.message || payload?.message || `API Key 当前不可用（HTTP ${status}）`);
    return {
      usage: usageResult(provider, {
        planName: provider.name,
        providerScopedName: true,
        used: local.totalCost,
        remaining: null,
        total: null,
        unit: 'USD',
        extra: apiKeyDetails(message, `请求次数：${local.requestCount}`),
      }),
      source: 'api_health_and_local_usage',
      loginRequired: false,
      degraded: !valid,
    };
  }
}
