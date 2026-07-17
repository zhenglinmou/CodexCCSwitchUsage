import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeUsage } from './usage-client.mjs';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const QUOTA_PER_USD = 500_000;
const WHAM_BROWSER_PROBE_TIMEOUT_MS = 5_000;
const WHAM_BROWSER_RACE_DELAY_MS = 400;
const WHAM_DIRECT_BACKOFF_MS = 300_000;
const WHAM_RESULT_CACHE_MS = 30_000;
const PROVIDER_QUERY_TIMEOUT_MS = 45_000;

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

function authenticationFailure(status, payload, raw = {}) {
  if (raw?.loginRequired === true) return true;
  if (Number(status) === 401 && payload && typeof payload === 'object') return true;
  const message = String(payload?.message || payload?.error || raw?.message || '');
  return /(?:未登录|请.{0,8}登录|登录.{0,8}(?:失效|过期)|not\s+(?:logged|signed)\s+in|unauthori[sz]ed|authentication\s+required|login\s+required|invalid\s+session)/i.test(message);
}

function interactiveWafFailure(status, payload, raw = {}) {
  const text = String(payload?.message || payload?.error || raw?.text || raw?.error || raw?.message || '');
  if (Number(status) === 403) return true;
  if (payload && typeof payload === 'object') return false;
  return /(?:cloudflare|challenge|just a moment|attention required|enable javascript|captcha|waf)/i.test(text);
}

function browserPageUnavailable(message) {
  return /(?:frame with id .*error page|no frame with id|cannot access contents|net::err_|showing error page)/i.test(String(message || ''));
}

function providerApiBase(provider) {
  return String(provider?.apiBaseUrl || provider?.baseUrl || '').replace(/\/+$/, '');
}

function usageResult(provider, values) {
  return normalizeUsage(provider, {
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
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('额度接口响应过大');
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

export function providerKind(provider) {
  const name = String(provider?.name || '').toLowerCase().replace(/\s+/g, '');
  if (name.includes('agentrouter')) return 'agentrouter';
  if (name.includes('anyrouter') || name.startsWith('any的') || name.startsWith('any路由')) return 'anyrouter';
  if (name.includes('openai')) return 'openai';
  if (name.includes('packy')) return 'packy';
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('付费站')) return 'paid';
  if (name.includes('cpa')) return 'cpa';
  if (name.includes('chy')) return 'health';
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
        websiteUrl: provider.websiteUrl,
      },
    };
  }

  async #queryUncached(provider, signal) {
    const kind = providerKind(provider);
    if (kind === 'anyrouter' || kind === 'agentrouter') return this.#queryWebProvider(provider, signal);
    if (kind === 'openai') return this.#queryOpenAi(provider, signal);
    if (kind === 'cpa') return this.#queryCpa(provider, signal);
    if (kind === 'deepseek') return this.#queryDeepSeek(provider, signal);
    if (kind === 'packy') return this.#queryPacky(provider, signal);
    if (kind === 'paid') return this.#queryPaid(provider, signal);
    if (provider.apiKey && providerApiBase(provider)) return this.#queryHealth(provider, signal);
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
        { ...config, headers: {}, waitMs: kind === 'agentrouter' ? 55_000 : 40_000 },
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
    if (!payload?.success || !payload?.data) {
      throw new Error(String(payload?.message || `第三方网站余额接口返回 HTTP ${Number(raw?.status) || 0}`));
    }
    const data = payload.data;
    const remaining = (Number(data.quota) || 0) / QUOTA_PER_USD;
    const used = (Number(data.used_quota) || 0) / QUOTA_PER_USD;
    return {
      usage: usageResult(provider, {
        planName: data.group || provider.name,
        remaining,
        used,
        total: remaining + used,
        unit: 'USD',
        extra: data.request_count == null ? '' : `请求次数：${Number(data.request_count) || 0}`,
      }),
      source: 'browser_session',
      loginRequired: false,
    };
  }

  async #queryDeepSeek(provider, signal) {
    const baseUrl = providerApiBase(provider) || 'https://api.deepseek.com';
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    }, 40_000, 2, signal);
    if (status !== 200 || !payload?.is_available) throw new Error(String(payload?.message || `DeepSeek 余额接口返回 HTTP ${status}`));
    const balances = (payload.balance_infos || []).map(item => ({ currency: String(item.currency || ''), value: Number(item.total_balance) || 0 }));
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
    if (status !== 200 || payload?.code !== true || !payload.data) throw new Error(String(payload?.message || `PackyCode 余额接口返回 HTTP ${status}`));
    const remaining = (Number(payload.data.total_available) || 0) / QUOTA_PER_USD;
    const used = (Number(payload.data.total_used) || 0) / QUOTA_PER_USD;
    return {
      usage: usageResult(provider, { planName: 'PackyCode', remaining, used, total: remaining + used, unit: 'USD', extra: `重置周期：${payload.data.quota_reset_period || '未知'}` }),
      source: 'provider_api',
      loginRequired: false,
    };
  }

  async #queryPaid(provider, signal) {
    const baseUrl = providerApiBase(provider);
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
      if (result?.status === 200 && result.payload) {
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
        definitive: Boolean(result.payload) || ![403, 429, 500, 502, 503, 504].includes(result.status),
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
        waitMs: 30_000,
      }, { signal: combinedSignal(signal, browserController.signal) }).then(raw => {
        const result = { status: Number(raw?.status) || 0, payload: parseBrowserJson(raw?.text), text: String(raw?.text || ''), transport: 'edge' };
        return { kind: 'browser', definitive: result.status === 200 && Boolean(result.payload), result, error: null };
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
    let result = accessToken && accountId ? await this.#queryWham(accessToken, accountId, signal) : { status: 401, payload: null };
    if (result.status !== 200 || !result.payload) {
      const browserResult = await this.#queryOpenAiBrowser(provider, signal).catch(() => null);
      if (browserResult) return browserResult;
      return { source: 'openai_wham', loginRequired: true, message: String(result.payload?.error?.message || 'OpenAI 登录已失效，请在 Hub 中重新登录') };
    }
    return this.#openAiUsage(provider, result.payload, result.transport === 'edge' ? 'openai_wham_browser' : 'openai_wham');
  }

  async #queryOpenAiBrowser(provider, signal) {
    if (!this.browserBroker.hasSession('https://chatgpt.com')) return null;
    const config = loginConfiguration(provider);
    const raw = await this.browserBroker.queryJson(config, { signal });
    const session = parseBrowserJson(raw?.text);
    const accessToken = String(session?.accessToken || session?.access_token || '');
    const accountId = accountIdFromSession(session, accessToken);
    if (!accessToken || !accountId) return null;
    const result = await this.#queryWham(accessToken, accountId, signal);
    if (result.status !== 200 || !result.payload) return null;
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
        summary: result.status === 200 && result.payload ? summarizeWham(result.payload) : null,
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
    const baseUrl = providerApiBase(provider);
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
