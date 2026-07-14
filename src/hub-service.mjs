import fs from 'node:fs';
import { loginConfiguration } from './hub-provider-adapters.mjs';

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
      const previous = this.items.get(provider.id) || this.cachedItems[provider.id] || {};
      this.items.set(provider.id, {
        id: provider.id,
        name: provider.name,
        websiteUrl: safeWebsiteUrl(provider.websiteUrl),
        current: provider.isCurrent,
        status: previous.status === 'loading' ? 'idle' : (previous.status || 'idle'),
        message: String(previous.message || ''),
        source: String(previous.source || ''),
        loginSupported: Boolean(loginConfiguration(provider)),
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

  recordCurrent(provider, payload) {
    if (!provider?.id || !this.items.has(provider.id)) return false;
    const item = this.items.get(provider.id);
    const usage = safeUsage(payload);
    this.items.set(provider.id, {
      ...item,
      current: true,
      status: usage ? 'ok' : String(payload?.status || 'error'),
      message: usage ? '' : safeMessage(payload?.message || payload?.queryError || '查询失败'),
      source: usage ? 'usage_script' : item.source,
      usage: usage || item.usage,
      updatedAt: String(payload?.updatedAt || new Date().toISOString()),
    });
    this.revision += 1;
    this.#writeCache();
    return true;
  }

  refreshProvider(providerId) {
    const id = String(providerId || '');
    if (!this.providers.has(id)) return Promise.reject(new Error('CCSwitch 中不存在这个 Codex 供应商'));
    if (this.refreshes.has(id)) return this.refreshes.get(id);
    const provider = this.providers.get(id);
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
          usage: usage || this.items.get(id).usage,
          updatedAt: String(usage?.updatedAt || new Date().toISOString()),
        };
        this.items.set(id, next);
        return next;
      } catch (error) {
        const next = {
          ...this.items.get(id),
          status: 'error',
          message: safeMessage(error),
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

  async openLogin(providerId) {
    const id = String(providerId || '');
    const provider = this.providers.get(id);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    if (!loginConfiguration(provider)) throw new Error('该供应商不支持网页登录修复');
    await this.queryEngine.openLogin(provider);
    const item = this.items.get(id);
    this.items.set(id, {
      ...item,
      status: item.usage ? item.status : 'login-required',
      message: '已打开专用 Edge 登录页；登录完成后回到 Hub 点击重新查询',
    });
    this.revision += 1;
    return this.items.get(id);
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
