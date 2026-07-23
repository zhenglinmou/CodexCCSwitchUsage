import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROVIDER_QUERY_TIMEOUT_MS } from '../browser-companion/protocol.js';
import { normalizeUsage, readResponseTextLimited } from './usage-client.mjs';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const QUOTA_PER_USD = 500_000;
const WHAM_BROWSER_PROBE_TIMEOUT_MS = 5_000;
const WHAM_BROWSER_RACE_DELAY_MS = 400;
const WHAM_DIRECT_BACKOFF_MS = 300_000;
const WHAM_RESULT_CACHE_MS = 30_000;
const PROVIDER_SCOPED_NAME = Symbol('providerScopedName');

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
  if (root?.code !== true || !data) throw new Error(String(root?.message || 'PackyCode 余额响应缺少 code/data'));
  const availableQuota = schemaNumber(data.total_available, 'total_available');
  const usedQuota = schemaNumber(data.total_used, 'total_used');
  return {
    remaining: availableQuota / QUOTA_PER_USD,
    used: usedQuota / QUOTA_PER_USD,
    total: (availableQuota + usedQuota) / QUOTA_PER_USD,
    resetPeriod: typeof data.quota_reset_period === 'string' && data.quota_reset_period.trim()
      ? data.quota_reset_period.trim()
      : '未知',
  };
}

const DEFAULT_KNOWN_NEW_API_DISPLAY = Object.freeze({ quotaPerUnit: QUOTA_PER_USD, multiplier: 1, unit: 'USD' });

function parseKnownNewApiDisplayPayload(payload, providerLabel) {
  const root = record(payload);
  const data = record(root?.data);
  if (root?.success !== true || !data) throw new Error(String(root?.message || `${providerLabel}站点配置响应缺少 success/data`));
  const displayType = String(data.quota_display_type || '').trim().toUpperCase();
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
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return '';
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

export async function fetchJson(fetchImpl, url, headers, timeoutMs = 40_000, attempts = 2, externalSignal = null, retryDelayMs = 500) {
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
        redirect: 'follow',
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
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(0, retryDelayMs), remainingAfterAttemptMs - 1)));
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

export function summarizeWham(payload) {
  if (!isWhamUsagePayload(payload)) throw new Error('OpenAI 用量响应缺少有效额度窗口');
  const rateLimit = payload?.rate_limit || {};
  const limits = [];
  for (const [id, fallback] of [['primary', '主窗口'], ['secondary', '次窗口']]) {
    const window = rateLimit[`${id}_window`];
    if (!window || typeof window !== 'object') continue;
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
    const window = rateLimit[key];
    return window && typeof window === 'object' && finiteOrNull(window.used_percent) !== null;
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
  if (hasProviderApiDomain(provider, 'packyapi.com')) return 'packy';
  if (hasProviderApiDomain(provider, 'deepseek.com') || (name.includes('deepseek') && Boolean(providerApiBase(provider)))) return 'deepseek';
  if (hasProviderApiDomain(provider, 'rawchat.cn', 'sharedchat.top') || name.includes('付费站')) return 'paid';
  if (name.includes('cpa') && hasLoopbackProviderBase(provider)) return 'cpa';
  if (hasProviderDomain(provider, 'chybenzun.top') || name.includes('chy')) return 'health';
  return 'generic';
}

export function loginConfiguration(provider) {
  switch (providerKind(provider)) {
    case 'anyrouter':
      return { baseUrl: 'https://anyrouter.top', loginUrl: 'https://anyrouter.top/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'agentrouter':
      return { baseUrl: 'https://agentrouter.org', loginUrl: 'https://agentrouter.org/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'openai':
      return { baseUrl: 'https://chatgpt.com', loginUrl: 'https://chatgpt.com/auth/login', requestPath: '/api/auth/session', navigateRequest: false };
    case 'jianzhile':
      return { baseUrl: 'https://jianzhile.vip', loginUrl: 'https://jianzhile.vip/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'freely':
      return { baseUrl: 'https://free.lyclaude.site', loginUrl: 'https://free.lyclaude.site/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'muyuan':
      return { baseUrl: 'https://muyuan.do', loginUrl: 'https://muyuan.do/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    case 'welfare':
      return { baseUrl: 'https://welfare.0xpsyche.me', loginUrl: 'https://welfare.0xpsyche.me/login', requestPath: '/api/user/self', userHeader: 'New-Api-User', navigateRequest: true };
    default:
      return null;
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

export function describeProviderQuery(provider) {
  const kind = providerKind(provider);
  const apiBaseUrl = providerApiBase(provider);
  const common = { method: 'GET', waf: false, requiresBrowser: false, notes: [] };
  if (kind === 'anyrouter' || kind === 'agentrouter') {
    const config = loginConfiguration(provider);
    return {
      ...common,
      type: 'browser-cookie',
      label: '现有浏览器 Cookie / WAF 查询',
      requestUrl: safeRequestUrl(config.baseUrl, config.requestPath),
      authentication: `当前浏览器 Cookie${config.userHeader ? ` + 扩展本地保存的数字用户 ID（${config.userHeader}）` : ''}`,
      executor: 'Edge/Chrome 余额伴侣，同源页面请求',
      waf: true,
      requiresBrowser: true,
      notes: [
        'Cookie 原文保留在当前浏览器，不回传到 Balance Hub',
        'WAF 或登录失败时只显示“去官网认证”，必须由用户手动触发',
      ],
    };
  }
  if (kind === 'openai') {
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
  if (kind === 'cpa') {
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
  if (kind === 'jianzhile') {
    return {
      ...common,
      type: 'api-key-with-account-fallback',
      label: '简直了 API Key / 账户总额度',
      requestUrl: 'https://jianzhile.vip/api/usage/token/',
      authentication: 'Bearer API Key；无限 Key 时使用简直了官网登录态',
      executor: '有限 Key 由 Balance Hub 直接查询；无限 Key 由 Edge/Chrome 伴侣查询账户总额度',
      waf: true,
      notes: [
        '此分支仅对 jianzhile.vip 生效',
        '有限 API Key 显示 Key 自身额度；无限 API Key 不使用负数或 100000000 占位值',
        '无限 API Key 需要官网登录态；Cookie 和 Token 原文不回传页面',
      ],
    };
  }
  if (kind === 'freely') {
    return {
      ...common,
      type: 'api-key-with-account-fallback',
      label: 'freely API Key / 账户总额度',
      requestUrl: 'https://free.lyclaude.site/api/usage/token/',
      authentication: 'Bearer API Key；无限 Key 时使用 freely 官网登录态',
      executor: '有限 Key 由 Balance Hub 直接查询；无限 Key 由 Edge/Chrome 伴侣查询账户总额度',
      waf: true,
      notes: [
        '此分支仅对 free.lyclaude.site 生效',
        '有限 API Key 显示 Key 自身额度；无限 API Key 不使用 100000000 占位值',
        '无限 API Key 需要官网登录态；Cookie 和 Token 原文不回传页面',
      ],
    };
  }
  if (kind === 'muyuan') {
    return {
      ...common,
      type: 'api-key-with-account-fallback',
      label: '君的公益 API Key / 账户总额度',
      requestUrl: 'https://muyuan.do/api/usage/token/',
      authentication: 'Bearer API Key；无限 Key 时使用君的公益官网登录态',
      executor: '有限 Key 直接查询；Cloudflare/WAF 或无限 Key 时由 Edge/Chrome 浏览器伴侣执行同源查询',
      waf: true,
      notes: [
        '此分支仅对配置的 muyuan.do API 域名生效',
        '有限 API Key 显示 Key 自身额度；无限 API Key 显示所属账户总额度',
        'Cloudflare/WAF 回退只在现有浏览器内执行；Cookie 和 Token 原文不进入 Hub 页面',
      ],
    };
  }
  if (kind === 'welfare') {
    return {
      ...common,
      type: 'api-key-with-account-fallback',
      label: '无名公益站 API Key / 账户总额度',
      requestUrl: 'https://welfare.0xpsyche.me/api/usage/token/',
      authentication: 'Bearer API Key；无限 Key 时使用无名公益站官网登录态',
      executor: '有限 Key 由 Balance Hub 直接查询；无限 Key 由 Edge/Chrome 伴侣查询账户总额度',
      notes: [
        '此分支仅对配置的 welfare.0xpsyche.me API 域名生效',
        '有限 API Key 显示 Key 自身额度；无限 API Key 显示所属账户总额度',
        '无限 API Key 需要官网登录态；Cookie 和 Token 原文不回传页面',
      ],
    };
  }
  if (kind === 'deepseek') {
    return {
      ...common,
      type: 'api-key',
      label: 'DeepSeek 官方余额 API',
      requestUrl: safeRequestUrl(apiBaseUrl || 'https://api.deepseek.com', '/user/balance'),
      authentication: 'Bearer API Key',
      executor: 'Balance Hub 直接请求第三方官网',
    };
  }
  if (kind === 'packy') {
    return {
      ...common,
      type: 'api-key',
      label: 'PackyCode 官方用量 API',
      requestUrl: 'https://www.packyapi.com/api/usage/token/',
      authentication: 'Bearer API Key',
      executor: 'Balance Hub 直接请求第三方官网',
    };
  }
  if (kind === 'paid') {
    return {
      ...common,
      type: 'api-key',
      label: '第三方窗口额度 API',
      requestUrl: safeRequestUrl(apiBaseUrl, '/user/balance'),
      authentication: 'Bearer API Key',
      executor: 'Balance Hub 直接请求第三方官网',
      notes: ['读取 3 小时与 1 天窗口；相同 API Key 的镜像站复用一次查询结果'],
    };
  }
  return {
    ...common,
    type: 'api-health',
    label: 'API Key 能力检查与本地统计',
    requestUrl: safeRequestUrl(apiBaseUrl, '/models'),
    authentication: 'Bearer API Key',
    executor: 'Balance Hub 检查模型 API；余额不可用时显示 CCSwitch 本地费用',
    notes: ['该站没有已知的模型 Key 余额接口'],
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
    this.homeDir = options.homeDir || process.env.USERPROFILE || process.env.HOME || '';
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

  async query(provider) {
    const cacheKey = this.#sharedQueryKey(provider);
    const cached = cacheKey ? this.recentQueries.get(cacheKey) : null;
    if (cached && Date.now() - cached.createdAt < 30_000) return this.#copyResult(cached.result, provider);
    if (cacheKey && this.inFlightQueries.has(cacheKey)) {
      return this.#copyResult(await this.inFlightQueries.get(cacheKey), provider);
    }
    const operation = this.#queryWithDeadline(provider);
    if (cacheKey) this.inFlightQueries.set(cacheKey, operation);
    try {
      const result = await operation;
      if (cacheKey && result?.usage) this.recentQueries.set(cacheKey, { result, createdAt: Date.now() });
      return this.#copyResult(result, provider);
    } finally {
      if (cacheKey) this.inFlightQueries.delete(cacheKey);
      const cutoff = Date.now() - 30_000;
      for (const [key, item] of this.recentQueries) {
        if (item.createdAt < cutoff) this.recentQueries.delete(key);
      }
    }
  }

  async #queryWithDeadline(provider) {
    const controller = new AbortController();
    const timeoutError = new Error(`供应商余额查询超过 ${Math.ceil(this.providerQueryTimeoutMs / 1_000)} 秒`);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.providerQueryTimeoutMs);
    });
    try {
      return await Promise.race([this.#queryUncached(provider, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #sharedQueryKey(provider) {
    const kind = providerKind(provider);
    if (['openai', 'cpa'].includes(kind)) return '';
    if (kind === 'anyrouter' || kind === 'agentrouter') return `browser:${kind}`;
    const baseIdentity = kind === 'paid' ? '' : providerApiBase(provider);
    const material = [kind, baseIdentity, provider.apiKey].join('\0');
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

  async #queryUncached(provider, signal) {
    const kind = providerKind(provider);
    if (kind === 'anyrouter' || kind === 'agentrouter') return this.#queryWebProvider(provider, signal);
    if (kind === 'openai') return this.#queryOpenAi(provider, signal);
    if (kind === 'cpa') return this.#queryCpa(provider, signal);
    if (kind === 'jianzhile') return this.#queryJianzhile(provider, signal);
    if (kind === 'freely') return this.#queryFreely(provider, signal);
    if (kind === 'muyuan') return this.#queryMuyuan(provider, signal);
    if (kind === 'welfare') return this.#queryWelfare(provider, signal);
    if (kind === 'deepseek') return this.#queryDeepSeek(provider, signal);
    if (kind === 'packy') return this.#queryPacky(provider, signal);
    if (kind === 'paid') return this.#queryPaid(provider, signal);
    if (provider.apiKey && configuredProviderApiBase(provider)) return this.#queryHealth(provider, signal);
    throw new Error('该供应商没有可用的 API Key、Base URL 或内置余额适配器');
  }

  async openLogin(provider) {
    const config = loginConfiguration(provider);
    if (!config) throw new Error('该供应商不支持网页登录修复');
    if (!this.browserBroker.isConnected()) throw new Error('请先连接现有 Edge/Chrome 的余额伴侣扩展');
    const result = await this.browserBroker.openLogin(config);
    return {
      success: true,
      loginUrl: config.loginUrl,
      synced: result?.synced === true,
      opened: result?.opened === true,
      loginRequired: result?.loginRequired === true,
      message: String(result?.message || ''),
    };
  }

  async #queryWebProvider(provider, signal) {
    if (this.browserBroker.isConnected()) {
      return this.#queryBrowserNewApi(provider, signal);
    }
    return {
      source: 'browser_session',
      loginRequired: false,
      message: '现有 Edge/Chrome 的余额伴侣扩展未连接；未执行无余额价值的模型 API 探测',
    };
  }

  async #queryBrowserNewApi(provider, signal) {
    const kind = providerKind(provider);
    const config = loginConfiguration(provider);
    if (!this.browserBroker.isConnected()) {
      return { source: 'browser_session', loginRequired: false, message: '现有 Edge/Chrome 的余额伴侣扩展未连接' };
    }
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
    const balance = parseNewApiBalancePayload(payload);
    return {
      usage: usageResult(provider, {
        planName: balance.group || provider.name,
        providerScopedName: !balance.group,
        remaining: balance.remaining,
        used: balance.used,
        total: balance.total,
        unit: 'USD',
        extra: balance.requestCount == null ? '' : `请求次数：${balance.requestCount}`,
      }),
      source: 'browser_session',
      loginRequired: false,
    };
  }

  async #queryJianzhile(provider, signal) {
    return this.#queryKnownNewApi(provider, signal, {
      label: '简直了',
      apiKeySource: 'jianzhile_api_key',
      accountSource: 'jianzhile_account',
      finiteExtra: '有限 API Key：显示 Key 自身总额度',
      accountExtra: '无限 API Key：显示所属账户总额度',
    });
  }

  async #queryFreely(provider, signal) {
    return this.#queryKnownNewApi(provider, signal, {
      label: 'freely',
      apiKeySource: 'freely_api_key',
      accountSource: 'freely_account',
      finiteExtra: '',
      accountExtra: '',
    });
  }

  async #queryMuyuan(provider, signal) {
    return this.#queryKnownNewApi(provider, signal, {
      label: '君的公益',
      apiKeySource: 'muyuan_api_key',
      accountSource: 'muyuan_account',
      browserSource: 'muyuan_browser',
      finiteExtra: '',
      accountExtra: '',
      browserApiFallback: true,
      localUsageFallback: true,
      directTimeoutMs: 8_000,
      directAttempts: 1,
    });
  }

  async #queryWelfare(provider, signal) {
    return this.#queryKnownNewApi(provider, signal, {
      label: '无名公益站',
      apiKeySource: 'welfare_api_key',
      accountSource: 'welfare_account',
      finiteExtra: '',
      accountExtra: '',
    });
  }

  async #queryKnownNewApi(provider, signal, site) {
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
        fetchJson(this.fetchImpl, `${origin}/api/usage/token/`, tokenHeaders, 40_000, 2, signal),
        fetchJson(this.fetchImpl, `${origin}/api/status`, statusHeaders, 40_000, 2, signal),
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
          extra: site.finiteExtra,
        }),
        source: browserApiUsed ? site.browserSource : site.apiKeySource,
        loginRequired: false,
      };
    }

    const config = loginConfiguration(provider);
    if (typeof this.browserBroker?.isConnected !== 'function' || !this.browserBroker.isConnected()) {
      return {
        source: site.accountSource,
        loginRequired: true,
        sessionSyncRequired: true,
        message: `${site.label} API Key 为无限额度；请连接并同步 ${site.label} 官网登录态，以读取账户总额度`,
      };
    }

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
    const account = parseKnownNewApiAccountPayload(accountPayload, display, site.label);
    const usedCandidates = [account.used, token.used].filter(value => Number.isFinite(value));
    const used = usedCandidates.length ? Math.max(...usedCandidates) : null;
    return {
      usage: usageResult(provider, {
        planName: `${provider.name} 账户总额度`,
        remaining: account.remaining,
        used,
        total: used == null ? account.total : account.remaining + used,
        unit: display.unit,
        extra: site.accountExtra,
      }),
      source: site.accountSource,
      loginRequired: false,
    };
  }

  async #queryDeepSeek(provider, signal) {
    const baseUrl = requiredProviderApiBase(provider, 'https://api.deepseek.com');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    }, 40_000, 2, signal);
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
        extra: balances.map(item => `${item.currency}: ${item.value}`).join('，'),
      }),
      source: 'official_api',
      loginRequired: false,
    };
  }

  async #queryPacky(provider, signal) {
    const { status, payload } = await fetchJson(this.fetchImpl, 'https://www.packyapi.com/api/usage/token/', {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'cc-switch/1.0',
    }, 40_000, 2, signal);
    if (status !== 200) throw new Error(String(payload?.message || `PackyCode 余额接口返回 HTTP ${status}`));
    const balance = parsePackyBalancePayload(payload);
    return {
      usage: usageResult(provider, { planName: 'PackyCode', remaining: balance.remaining, used: balance.used, total: balance.total, unit: 'USD', extra: `重置周期：${balance.resetPeriod}` }),
      source: 'provider_api',
      loginRequired: false,
    };
  }

  async #queryPaid(provider, signal) {
    const baseUrl = requiredProviderApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error('付费站没有可用的 API Key 或 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'codex-ccswitch-usage/2',
    }, 40_000, 2, signal);
    if (status !== 200 || !payload || typeof payload !== 'object') throw new Error(`付费站余额接口返回 HTTP ${status}`);
    const active = payload.status == null ? payload.is_active !== false : payload.status === 'ok';
    const quota3h = payload.quota?.['3h'] || { total: payload.limit_3h, used: payload.used_3h, remaining: payload.balance_3h };
    const daily = payload.quota?.daily || { total: payload.limit_1d, used: payload.used_1d, remaining: payload.balance_1d };
    const used = finiteOrNull(daily.used);
    const remaining = finiteOrNull(daily.remaining);
    const total = finiteOrNull(daily.total);
    if (!active || used == null || remaining == null || total == null || total <= 0) {
      throw new Error(String(payload.message || payload.reason || '付费站额度数据不完整'));
    }
    const short = value => {
      const number = finiteOrNull(value);
      return number == null ? '--' : (Math.trunc(number * 100) / 100).toFixed(2);
    };
    return {
      usage: usageResult(provider, {
        planName: provider.name,
        providerScopedName: true,
        extra: `3H剩:${short(quota3h.remaining)}`,
        periodLabel: '1D',
        hideTotal: true,
        used,
        remaining,
        total,
        unit: String(payload.unit || ''),
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
    const raw = await this.browserBroker.queryJson(config, { signal });
    const session = parseBrowserJson(raw?.text);
    const accessToken = String(session?.accessToken || session?.access_token || '');
    const accountId = accountIdFromSession(session, accessToken);
    if (!accessToken || !accountId) return null;
    const result = await this.#queryWham(accessToken, accountId, signal);
    if (result.status !== 200 || !isWhamUsagePayload(result.payload)) return null;
    return this.#openAiUsage(provider, result.payload, 'browser_session');
  }

  #openAiUsage(provider, payload, source) {
    const summary = summarizeWham(payload);
    const details = summary.limits.map(item => {
      const reset = item.resetAfterSeconds ? `，约 ${Math.floor(item.resetAfterSeconds / 60)} 分钟后重置` : '';
      return `${item.label} ${item.remaining.toFixed(1)}% 可用${reset}`;
    });
    if (summary.creditBalance != null) details.push(`Credits ${summary.creditBalance}`);
    return {
      usage: usageResult(provider, { planName: `OpenAI ${summary.plan}`, remaining: summary.remaining, used: summary.used, total: 100, unit: '%', extra: details.join('；') }),
      source,
      loginRequired: false,
    };
  }

  #cpaAuthFiles() {
    const directory = path.join(this.homeDir, '.cli-proxy-api');
    try {
      return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(entry => path.join(directory, entry.name));
    } catch {
      return [];
    }
  }

  #readCpaAuth(filename) {
    try {
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
      .map(item => ({ ...item, modifiedAt: fs.statSync(item.filename).mtimeMs }))
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

  async #queryHealth(provider, signal) {
    const baseUrl = requiredProviderApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error('该站没有可用于健康检查的 API Key 或 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/models`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    }, 40_000, 2, signal);
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
        extra: `${message}；请求次数：${local.requestCount}`,
      }),
      source: 'api_health_and_local_usage',
      loginRequired: false,
      degraded: !valid,
    };
  }
}
