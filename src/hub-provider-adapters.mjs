import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeUsage, queryUsage } from './usage-client.mjs';
import { parseBrowserJson } from './edge-session.mjs';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const QUOTA_PER_USD = 500_000;

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

async function fetchJson(fetchImpl, url, headers, timeoutMs = 40_000) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readJsonResponse(response);
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

export function solveAnyRouterChallenge(arg1) {
  const permutation = [15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36];
  const xorKey = '3000176000856006061501533003690027800375';
  const reordered = Array(40).fill('');
  for (let index = 0; index < String(arg1).length; index += 1) {
    const destination = permutation.findIndex(source => source === index + 1);
    if (destination >= 0) reordered[destination] = String(arg1)[index];
  }
  const value = reordered.join('');
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('AnyRouter WAF 挑战格式无效');
  let result = '';
  for (let index = 0; index < 40; index += 2) {
    result += (Number.parseInt(value.slice(index, index + 2), 16) ^ Number.parseInt(xorKey.slice(index, index + 2), 16)).toString(16).padStart(2, '0');
  }
  return result;
}

function bridgeProviderId(provider) {
  const kind = providerKind(provider);
  const name = String(provider.name || '').toLowerCase();
  if (kind === 'anyrouter') return name.includes('国内') ? 'anyrouter_cn' : 'anyrouter';
  if (kind === 'agentrouter') return 'agentrouter';
  if (kind === 'openai') return name.includes('我自己的') ? 'openai_personal' : 'openai_official';
  if (kind === 'packy') return 'packycode';
  if (kind === 'deepseek') return 'deepseek';
  if (kind === 'paid') return name.includes('copy') ? 'paid_sharedchat' : 'paid_rawchat';
  if (kind === 'cpa') return 'cpa';
  if (kind === 'health') return 'chy';
  return '';
}

function isLegacyBridgeUsage(provider) {
  const code = String(provider?.usage?.code || '');
  return /127\.0\.0\.1:17891|\/v1\/balance\/(?:agentrouter|anyrouter)/i.test(code)
    || /^http:\/\/(?:127\.0\.0\.1|localhost):17891$/i.test(String(provider?.baseUrl || ''));
}

export class ProviderQueryEngine {
  constructor(repository, edgeSession, options = {}) {
    this.repository = repository;
    this.edgeSession = edgeSession;
    this.fetchImpl = options.fetchImpl || fetch;
    this.homeDir = options.homeDir || process.env.USERPROFILE || process.env.HOME || '';
    this.bridgeBaseUrl = options.bridgeBaseUrl || 'http://127.0.0.1:17891';
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
    const operation = this.#queryUncached(provider);
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

  #sharedQueryKey(provider) {
    const kind = providerKind(provider);
    if (['anyrouter', 'agentrouter', 'openai', 'cpa'].includes(kind)) return '';
    const baseIdentity = kind === 'paid' ? '' : provider.baseUrl;
    const material = [kind, baseIdentity, provider.apiKey, provider.usage?.code || ''].join('\0');
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

  async #queryUncached(provider) {
    let result;
    let failure;
    try {
      const kind = providerKind(provider);
      if (kind === 'anyrouter' || kind === 'agentrouter') return this.#queryWebProvider(provider);
      if (kind === 'openai') result = await this.#queryOpenAi(provider);
      else if (kind === 'cpa') result = await this.#queryCpa(provider);
      else if (kind === 'deepseek') result = await this.#queryDeepSeek(provider);
      else if (kind === 'health' && !provider.usage?.code) result = await this.#queryHealth(provider);
      else if (provider.usage?.enabled && String(provider.usage?.code || '').trim() && !isLegacyBridgeUsage(provider)) {
        result = { usage: await queryUsage(provider, { fetchImpl: this.fetchImpl }), source: 'usage_script', loginRequired: false };
      } else if (kind === 'packy') result = await this.#queryPacky(provider);
      else if (kind === 'paid') result = await this.#queryPaid(provider);
      else if (provider.apiKey && provider.baseUrl) result = await this.#queryHealth(provider);
      else throw new Error('该供应商没有可用的余额查询配置');
    } catch (error) {
      failure = error;
    }
    if (failure || (result?.loginRequired && !result.usage)) {
      const bridge = await this.#queryLegacyBridge(provider).catch(() => null);
      if (bridge) return bridge;
    }
    if (failure) throw failure;
    return result;
  }

  async openLogin(provider) {
    const config = loginConfiguration(provider);
    if (!config) throw new Error('该供应商不支持网页登录修复');
    await this.edgeSession.openLogin(config.loginUrl);
    return { success: true, loginUrl: config.loginUrl };
  }

  async #queryWebProvider(provider) {
    const kind = providerKind(provider);
    const config = loginConfiguration(provider);
    const hasBrowserState = this.edgeSession.hasLoginState?.(config.baseUrl) === true;
    let browserResult = null;
    if (hasBrowserState) {
      browserResult = await this.#queryBrowserNewApi(provider).catch(error => ({
        source: 'browser_session', loginRequired: true, message: error instanceof Error ? error.message : String(error),
      }));
      if (browserResult?.usage) return browserResult;
    }
    const bridge = await this.#queryLegacyBridge(provider).catch(() => null);
    if (bridge?.usage) return bridge;
    if (kind === 'anyrouter') {
      const direct = await this.#queryAnyRouterCookie(provider).catch(() => null);
      if (direct) return direct;
    }
    if (browserResult) return browserResult;
    if (bridge) return bridge;
    return this.#queryBrowserNewApi(provider);
  }

  async #queryBrowserNewApi(provider) {
    const kind = providerKind(provider);
    const config = loginConfiguration(provider);
    const accessToken = String(provider.usage?.accessToken || '');
    const userId = String(provider.usage?.userId || '');
    if (!this.edgeSession.hasPersistentState() && !accessToken && !userId) {
      return { source: 'browser_session', loginRequired: true, message: '需要先网页登录，登录状态会保存在 v2 的专用 Edge 会话中' };
    }
    const headers = {};
    if (accessToken && !accessToken.includes('=')) headers.Authorization = `Bearer ${accessToken}`;
    if (userId) headers[config.userHeader] = userId;
    const raw = await this.edgeSession.queryJson({ ...config, headers, waitMs: kind === 'agentrouter' ? 55_000 : 40_000 });
    const payload = parseBrowserJson(raw?.text);
    if (!payload?.success || !payload?.data) {
      return { source: 'browser_session', loginRequired: true, message: String(payload?.message || '网页登录已失效或 WAF 验证尚未完成') };
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

  async #queryLegacyBridge(provider) {
    const bridgeId = bridgeProviderId(provider);
    if (!bridgeId) return null;
    const kind = providerKind(provider);
    const timeoutMs = kind === 'agentrouter' ? 95_000 : kind === 'anyrouter' ? 65_000 : ['openai', 'cpa'].includes(kind) ? 50_000 : 15_000;
    const { status, payload } = await fetchJson(this.fetchImpl, `${this.bridgeBaseUrl}/v1/balance/${bridgeId}`, { Accept: 'application/json', 'Cache-Control': 'no-store' }, timeoutMs);
    if (status !== 200) return null;
    if (!payload?.success || !payload?.data) {
      if (payload?.login_required || payload?.loginRequired) {
        return { source: 'legacy_bridge', loginRequired: true, message: String(payload.message || '登录状态已失效') };
      }
      return null;
    }
    const data = payload.data;
    if (data.isValid === false) {
      return {
        source: 'legacy_bridge',
        loginRequired: Boolean(data.loginRequired || data.login_required),
        message: String(data.invalidMessage || payload.message || '登录状态已失效'),
      };
    }
    return {
      usage: usageResult(provider, data),
      source: 'legacy_bridge',
      loginRequired: Boolean(data.loginRequired),
    };
  }

  async #queryAnyRouterCookie(provider) {
    const cookie = String(provider.usage?.accessToken || '');
    const userId = String(provider.usage?.userId || '');
    if (!cookie.includes('=') || !userId) return null;
    let cookieHeader = cookie;
    let responsePayload = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { status, payload, text } = await fetchJson(this.fetchImpl, 'https://anyrouter.top/api/user/self', {
        Accept: 'application/json',
        'New-Api-User': userId,
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
      }, 45_000);
      if (status === 200 && payload?.success && payload?.data) {
        responsePayload = payload;
        break;
      }
      const challenge = text.match(/var\s+arg1=['"]([0-9a-f]{40})['"]/i)?.[1];
      if (!challenge) break;
      cookieHeader = `${cookieHeader}; acw_sc__v2=${solveAnyRouterChallenge(challenge)}`;
    }
    if (!responsePayload?.data) return null;
    const data = responsePayload.data;
    const remaining = (Number(data.quota) || 0) / QUOTA_PER_USD;
    const used = (Number(data.used_quota) || 0) / QUOTA_PER_USD;
    return {
      usage: usageResult(provider, { planName: data.group || provider.name, remaining, used, total: remaining + used, unit: 'USD' }),
      source: 'ccswitch_cookie',
      loginRequired: false,
    };
  }

  async #queryDeepSeek(provider) {
    const baseUrl = provider.baseUrl || 'https://api.deepseek.com';
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    });
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

  async #queryPacky(provider) {
    const { status, payload } = await fetchJson(this.fetchImpl, 'https://www.packyapi.com/api/usage/token/', {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'cc-switch/1.0',
    });
    if (status !== 200 || payload?.code !== true || !payload.data) throw new Error(String(payload?.message || `PackyCode 余额接口返回 HTTP ${status}`));
    const remaining = (Number(payload.data.total_available) || 0) / QUOTA_PER_USD;
    const used = (Number(payload.data.total_used) || 0) / QUOTA_PER_USD;
    return {
      usage: usageResult(provider, { planName: 'PackyCode', remaining, used, total: remaining + used, unit: 'USD', extra: `重置周期：${payload.data.quota_reset_period || '未知'}` }),
      source: 'provider_api',
      loginRequired: false,
    };
  }

  async #queryPaid(provider) {
    if (provider.usage?.code) return { usage: await queryUsage(provider, { fetchImpl: this.fetchImpl }), source: 'usage_script', loginRequired: false };
    throw new Error('付费站没有配置余额脚本');
  }

  async #queryWham(accessToken, accountId) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
      Accept: 'application/json',
      'User-Agent': 'codex-ccswitch-usage/2',
    };
    let direct = null;
    let directError = null;
    try {
      direct = await fetchJson(this.fetchImpl, WHAM_URL, headers, 40_000);
      if (direct.payload || ![403, 429, 500, 502, 503, 504].includes(direct.status)) return { ...direct, transport: 'node' };
    } catch (error) {
      directError = error;
    }
    try {
      const browserHeaders = { ...headers };
      delete browserHeaders['User-Agent'];
      const raw = await this.edgeSession.queryJson({
        baseUrl: 'https://chatgpt.com',
        requestPath: '/backend-api/wham/usage',
        headers: browserHeaders,
        navigateRequest: false,
        waitMs: 30_000,
      });
      return { status: Number(raw?.status) || 0, payload: parseBrowserJson(raw?.text), text: String(raw?.text || ''), transport: 'edge' };
    } catch (error) {
      if (direct) return { ...direct, transport: 'node' };
      throw directError || error;
    }
  }

  async #queryOpenAi(provider) {
    const tokens = provider.auth?.tokens || {};
    const accountId = String(tokens.account_id || '');
    let accessToken = String(tokens.access_token || '');
    const replacement = this.#findCpaToken(accountId);
    if (replacement?.access_token) accessToken = String(replacement.access_token);
    let result = accessToken && accountId ? await this.#queryWham(accessToken, accountId) : { status: 401, payload: null };
    if (result.status !== 200 || !result.payload) {
      const browserResult = await this.#queryOpenAiBrowser(provider).catch(() => null);
      if (browserResult) return browserResult;
      return { source: 'openai_wham', loginRequired: true, message: String(result.payload?.error?.message || 'OpenAI 登录已失效，请在 Hub 中重新登录') };
    }
    return this.#openAiUsage(provider, result.payload, result.transport === 'edge' ? 'openai_wham_browser' : 'openai_wham');
  }

  async #queryOpenAiBrowser(provider) {
    if (this.edgeSession.hasLoginState?.('https://chatgpt.com') !== true) return null;
    const config = loginConfiguration(provider);
    const raw = await this.edgeSession.queryJson(config);
    const session = parseBrowserJson(raw?.text);
    const accessToken = String(session?.accessToken || session?.access_token || '');
    const accountId = accountIdFromSession(session, accessToken);
    if (!accessToken || !accountId) return null;
    const result = await this.#queryWham(accessToken, accountId);
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

  async #queryCpa(provider) {
    const accounts = this.#cpaAuthFiles().map(filename => ({
      label: path.basename(filename, path.extname(filename)),
      auth: this.#readCpaAuth(filename),
    })).filter(item => item.auth?.access_token && item.auth?.account_id);
    const results = await mapWithConcurrency(accounts, 3, async item => {
      const result = await this.#queryWham(String(item.auth.access_token), String(item.auth.account_id)).catch(() => ({ status: 0, payload: null }));
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

  async #queryHealth(provider) {
    if (!provider.apiKey || !provider.baseUrl) throw new Error('该站没有可用于健康检查的 API Key 或 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${provider.baseUrl}/models`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
    });
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
