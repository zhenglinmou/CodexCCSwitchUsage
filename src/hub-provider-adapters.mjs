import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeUsage } from './usage-client.mjs';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const QUOTA_PER_USD = 500_000;

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

async function fetchJson(fetchImpl, url, headers, timeoutMs = 40_000) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result = await readJsonResponse(response);
      const retryable = [429, 500, 502, 503, 504].includes(result.status);
      if (!retryable || attempt > 0) return result;
    } catch (error) {
      lastError = error;
      if (attempt > 0) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError || new Error('余额接口请求失败');
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

  async #queryUncached(provider) {
    const kind = providerKind(provider);
    if (kind === 'anyrouter' || kind === 'agentrouter') return this.#queryWebProvider(provider);
    if (kind === 'openai') return this.#queryOpenAi(provider);
    if (kind === 'cpa') return this.#queryCpa(provider);
    if (kind === 'deepseek') return this.#queryDeepSeek(provider);
    if (kind === 'packy') return this.#queryPacky(provider);
    if (kind === 'paid') return this.#queryPaid(provider);
    if (provider.apiKey && providerApiBase(provider)) return this.#queryHealth(provider);
    throw new Error('该供应商没有可用的 API Key、Base URL 或内置余额适配器');
  }

  async openLogin(provider) {
    const config = loginConfiguration(provider);
    if (!config) throw new Error('该供应商不支持网页登录修复');
    if (!this.browserBroker.isConnected()) throw new Error('请先连接现有 Edge/Chrome 的余额伴侣扩展');
    await this.browserBroker.openLogin(config);
    return { success: true, loginUrl: config.loginUrl };
  }

  async #queryWebProvider(provider) {
    const config = loginConfiguration(provider);
    const hasBrowserState = this.browserBroker.hasSession(config.baseUrl);
    if (hasBrowserState) {
      return this.#queryBrowserNewApi(provider).catch(error => ({
        source: 'browser_session', loginRequired: true, message: error instanceof Error ? error.message : String(error),
      }));
    }
    const probe = await this.#probeApiKey(provider);
    return {
      source: 'api_key_probe',
      loginRequired: true,
      message: !this.browserBroker.isConnected()
        ? `${probe.message}；请先连接现有 Edge/Chrome 的余额伴侣扩展`
        : probe.valid
          ? '模型 API Key 可用，但该站余额需要网页登录；请在 Hub 中主动打开登录页，登录后再刷新'
          : `${probe.message}；余额需要在 Hub 中主动登录后查询`,
    };
  }

  async #queryBrowserNewApi(provider) {
    const kind = providerKind(provider);
    const config = loginConfiguration(provider);
    if (!this.browserBroker.isConnected()) {
      return { source: 'browser_session', loginRequired: true, message: '现有 Edge/Chrome 的余额伴侣扩展未连接' };
    }
    const raw = await this.browserBroker.queryJson({ ...config, headers: {}, waitMs: kind === 'agentrouter' ? 55_000 : 40_000 });
    if (raw?.loginRequired) {
      return { source: 'browser_session', loginRequired: true, message: String(raw.message || '现有浏览器尚未登录该网站') };
    }
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

  async #probeApiKey(provider) {
    const baseUrl = providerApiBase(provider);
    if (!provider.apiKey || !baseUrl) return { valid: false, message: '该站没有可用的模型 API Key 或 Base URL' };
    try {
      const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/models`, {
        Authorization: `Bearer ${provider.apiKey}`,
        Accept: 'application/json',
      }, 20_000);
      const valid = status === 200 && payload && Array.isArray(payload.data);
      const message = valid
        ? '模型 API Key 可用'
        : String(payload?.error?.message || payload?.message || (status === 200
          ? '模型接口返回非标准数据，无法确认 API Key'
          : `模型 API Key 检查返回 HTTP ${status}`));
      return { valid, message };
    } catch (error) {
      return { valid: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async #queryDeepSeek(provider) {
    const baseUrl = providerApiBase(provider) || 'https://api.deepseek.com';
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
    const baseUrl = providerApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error('付费站没有可用的 API Key 或 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/user/balance`, {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'codex-ccswitch-usage/2',
    });
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
      const raw = await this.browserBroker.queryJson({
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
    if (!this.browserBroker.hasSession('https://chatgpt.com')) return null;
    const config = loginConfiguration(provider);
    const raw = await this.browserBroker.queryJson(config);
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
    const baseUrl = providerApiBase(provider);
    if (!provider.apiKey || !baseUrl) throw new Error('该站没有可用于健康检查的 API Key 或 Base URL');
    const { status, payload } = await fetchJson(this.fetchImpl, `${baseUrl}/models`, {
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
