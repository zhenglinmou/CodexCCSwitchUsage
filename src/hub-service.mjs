import fs from 'node:fs';
import { describeProviderQuery, loginConfiguration, providerAliases } from './hub-provider-adapters.mjs';

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,}/g, '[redacted-jwt]')
    .replace(/(?:access[_-]?token|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function safeWebsiteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function safeUsage(payload) {
  if (!payload || payload.status !== 'ok') return null;
  const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    providerName: String(payload.providerName || ''),
    extra: safeMessage(payload.extra || ''),
    periodLabel: String(payload.periodLabel || ''),
    hideTotal: payload.hideTotal === true,
    refreshIntervalMinutes: Math.max(1, Number(payload.refreshIntervalMinutes) || 5),
    used: numberOrNull(payload.used),
    remaining: numberOrNull(payload.remaining),
    total: numberOrNull(payload.total),
    unit: String(payload.unit || ''),
    updatedAt: String(payload.updatedAt || new Date().toISOString()),
    queryError: payload.queryError ? safeMessage(payload.queryError) : '',
  };
}

function readCache(cachePath) {
  if (!cachePath) return {};
  try {
    const value = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.providers)) return {};
    return Object.fromEntries(value.providers.filter(item => item?.id).map(item => [String(item.id), item]));
  } catch {
    return {};
  }
}

export function hubItemToUsagePayload(provider, item) {
  const usage = item?.usage;
  if (usage) {
    const queryError = item.status === 'ok' ? '' : String(item.message || '最近一次 Hub 查询未成功');
    return {
      status: 'ok',
      providerId: provider.id,
      providerName: usage.providerName || provider.name,
      websiteUrl: provider.websiteUrl,
      extra: usage.extra,
      periodLabel: usage.periodLabel,
      hideTotal: usage.hideTotal,
      refreshIntervalMinutes: usage.refreshIntervalMinutes,
      used: usage.used,
      remaining: usage.remaining,
      total: usage.total,
      unit: usage.unit,
      updatedAt: usage.updatedAt,
      ...(queryError ? { queryError } : {}),
    };
  }
  return {
    status: item?.status === 'idle' || item?.status === 'loading' ? 'loading' : 'error',
    providerId: provider.id,
    providerName: provider.name,
    websiteUrl: provider.websiteUrl,
    message: String(item?.message || 'Balance Hub 尚未返回额度'),
    updatedAt: item?.updatedAt || new Date().toISOString(),
  };
}

export class HubService {
  constructor(repository, queryEngine, options = {}) {
    this.repository = repository;
    this.queryEngine = queryEngine;
    this.cachePath = options.cachePath || '';
    this.concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 3));
    this.items = new Map();
    this.providers = new Map();
    this.refreshes = new Map();
    this.refreshAllPromise = null;
    this.revision = 0;
    this.lastFullRefreshAt = '';
    this.cachedItems = readCache(this.cachePath);
    try { this.syncProviders(); } catch {}
  }

  syncProviders() {
    const providers = this.repository.getAll();
    const activeIds = new Set();
    for (const provider of providers) {
      activeIds.add(provider.id);
      this.providers.set(provider.id, provider);
      const loginConfig = loginConfiguration(provider);
      const livePrevious = this.items.get(provider.id);
      const previous = livePrevious || this.cachedItems[provider.id] || {};
      const obsoleteSource = ['legacy_bridge', 'usage_script', 'ccswitch_cookie'].includes(String(previous.source || ''));
      const staleBrowserFailure = !livePrevious
        && previous.source === 'browser_session'
        && previous.usage
        && ['error', 'login-required'].includes(String(previous.status || ''));
      const legacySessionSyncFailure = !livePrevious
        && previous.source === 'browser_session'
        && previous.usage
        && previous.status === 'degraded'
        && loginConfig?.userHeader
        && /浏览器伴侣连接后将自动重试|现有浏览器尚未登录/.test(String(previous.message || ''));
      const restoredBrowserFailure = staleBrowserFailure || legacySessionSyncFailure;
      const sessionSyncRequired = Boolean(
        previous.sessionSyncRequired
        || (restoredBrowserFailure && loginConfig?.userHeader),
      );
      this.items.set(provider.id, {
        id: provider.id,
        name: provider.name,
        websiteUrl: safeWebsiteUrl(provider.websiteUrl),
        current: provider.isCurrent,
        status: previous.status === 'loading' || obsoleteSource ? 'idle' : (staleBrowserFailure ? 'degraded' : (previous.status || 'idle')),
        message: obsoleteSource
          ? '等待 v2 独立余额中心重新查询'
          : restoredBrowserFailure
            ? (sessionSyncRequired
              ? '显示上次成功余额；请点击“同步现有会话”一次'
              : '显示上次成功余额；请手动重新登录后刷新')
            : String(previous.message || ''),
        source: obsoleteSource ? 'cached_previous' : String(previous.source || ''),
        loginSupported: Boolean(loginConfig),
        sessionSyncSupported: Boolean(loginConfig?.userHeader),
        sessionSyncRequired,
        queryMethod: describeProviderQuery(provider),
        usage: previous.usage || null,
        updatedAt: String(previous.updatedAt || ''),
      });
    }
    for (const id of this.items.keys()) {
      if (!activeIds.has(id)) {
        this.items.delete(id);
        this.providers.delete(id);
      }
    }
    this.cachedItems = {};
    this.revision += 1;
    return providers;
  }

  getState() {
    return {
      version: 2,
      revision: this.revision,
      refreshing: this.refreshes.size > 0,
      lastFullRefreshAt: this.lastFullRefreshAt,
      providers: [...this.items.values()].map(item => ({ ...item, refreshing: this.refreshes.has(item.id) })),
    };
  }

  findProvider(selector) {
    const key = String(selector || '').trim().toLowerCase();
    if (!key) return null;
    if (this.providers.has(key)) return this.providers.get(key);
    return [...this.providers.values()].find(provider => providerAliases(provider).includes(key)) || null;
  }

  listPublicProviders() {
    return [...this.providers.values()].map(provider => {
      const loginConfig = loginConfiguration(provider);
      return {
        id: provider.id,
        name: provider.name,
        aliases: providerAliases(provider),
        current: provider.isCurrent,
        loginSupported: Boolean(loginConfig),
        sessionSyncSupported: Boolean(loginConfig?.userHeader),
        queryMethod: describeProviderQuery(provider),
        balanceUrl: `/v1/balance/${encodeURIComponent(providerAliases(provider).at(-1) || provider.id)}`,
      };
    });
  }

  refreshProvider(providerSelector) {
    const resolved = this.findProvider(providerSelector);
    if (!resolved) return Promise.reject(new Error('CCSwitch 中不存在这个 Codex 供应商'));
    const id = resolved.id;
    if (this.refreshes.has(id)) return this.refreshes.get(id);
    const provider = resolved;
    const previous = this.items.get(id);
    this.items.set(id, { ...previous, status: previous.usage ? previous.status : 'loading', message: '' });
    this.revision += 1;
    const promise = (async () => {
      try {
        const result = await this.queryEngine.query(provider);
        const usage = safeUsage(result.usage);
        const next = {
          ...this.items.get(id),
          status: usage ? (result.degraded ? 'degraded' : 'ok') : (result.loginRequired ? 'login-required' : 'error'),
          message: usage ? (result.degraded ? 'API 可用性检查未通过，显示本地统计' : '') : safeMessage(result.message || '没有返回可显示的额度数据'),
          source: String(result.source || ''),
          sessionSyncRequired: result.sessionSyncRequired === true,
          usage: usage || this.items.get(id).usage,
          updatedAt: String(usage?.updatedAt || new Date().toISOString()),
        };
        this.items.set(id, next);
        return next;
      } catch (error) {
        const previous = this.items.get(id);
        const message = safeMessage(error);
        const next = {
          ...previous,
          status: previous.usage ? 'degraded' : 'error',
          message: previous.usage ? `最近查询失败：${message}` : message,
          updatedAt: new Date().toISOString(),
        };
        this.items.set(id, next);
        return next;
      } finally {
        this.refreshes.delete(id);
        this.revision += 1;
        this.#writeCache();
      }
    })();
    this.refreshes.set(id, promise);
    return promise;
  }

  refreshAll() {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.syncProviders();
    const ids = [...this.providers.keys()];
    this.refreshAllPromise = (async () => {
      let cursor = 0;
      const worker = async () => {
        while (cursor < ids.length) {
          const id = ids[cursor];
          cursor += 1;
          await this.refreshProvider(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker));
      this.lastFullRefreshAt = new Date().toISOString();
      this.revision += 1;
      this.#writeCache();
      return this.getState();
    })().finally(() => { this.refreshAllPromise = null; });
    return this.refreshAllPromise;
  }

  async queryBalance(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) return { success: false, message: `Unknown provider: ${String(providerSelector || '')}` };
    const item = await this.refreshProvider(provider.id);
    return this.#balanceResponse(item);
  }

  async queryAllBalances() {
    await this.refreshAll();
    return {
      success: [...this.items.values()].every(item => ['ok', 'degraded'].includes(item.status)),
      data: Object.fromEntries([...this.items.values()].map(item => [item.id, this.#balanceResponse(item)])),
    };
  }

  async openLogin(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    const id = provider.id;
    if (!loginConfiguration(provider)) throw new Error('该供应商不支持网页登录修复');
    const action = await this.queryEngine.openLogin(provider);
    if (action?.synced === true) return this.refreshProvider(id);
    const item = this.items.get(id);
    this.items.set(id, {
      ...item,
      status: item.usage ? item.status : 'login-required',
      sessionSyncRequired: Boolean(item.sessionSyncSupported && !action?.opened),
      message: safeMessage(action?.message || (action?.opened
        ? '已在现有浏览器中打开登录页；登录完成后回到 Hub 手动点击刷新'
        : '未能同步现有浏览器会话，请先在官网确认登录状态')),
    });
    this.revision += 1;
    return this.items.get(id);
  }

  #balanceResponse(item) {
    const queryable = ['ok', 'degraded'].includes(item.status) && item.usage;
    if (!queryable) {
      return {
        success: false,
        provider: item.id,
        message: item.message || '余额查询失败',
        login_required: item.status === 'login-required',
      };
    }
    return {
      success: true,
      provider: item.id,
      data: {
        isValid: true,
        planName: item.usage.providerName || item.name,
        remaining: item.usage.remaining,
        used: item.usage.used,
        total: item.usage.total,
        unit: item.usage.unit,
        extra: item.usage.extra,
        periodLabel: item.usage.periodLabel,
        hideTotal: item.usage.hideTotal,
        updatedAt: item.usage.updatedAt,
        source: item.source,
      },
    };
  }

  #writeCache() {
    if (!this.cachePath) return;
    try {
      const temporary = `${this.cachePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, providers: [...this.items.values()] }), 'utf8');
      fs.renameSync(temporary, this.cachePath);
    } catch {}
  }
}

export { safeMessage as safeHubMessage, safeUsage as sanitizeHubUsage };
