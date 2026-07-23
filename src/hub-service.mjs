import fs from 'node:fs';
import crypto from 'node:crypto';
import { describeProviderQuery, loginConfiguration, providerAliases, providerKind } from './hub-provider-adapters.mjs';

const MAX_SAFE_MESSAGE_CHARS = 8_192;
const LABELED_CREDENTIAL_PATTERN = /(["']?)(openai[_-]api[_-]key|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|cookie|authorization|secret)\1(\s*[=:]\s*)(?:Bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;

function isJwtRunCharacter(character) {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === '_'
    || character === '-'
    || character === '.';
}

function redactJwtLikeTokens(value) {
  const chunks = [];
  let index = 0;
  while (index < value.length) {
    if (!isJwtRunCharacter(value[index])) {
      chunks.push(value[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < value.length && isJwtRunCharacter(value[end])) end += 1;
    const parts = value.slice(index, end).split('.');
    const redacted = [];
    for (let part = 0; part < parts.length;) {
      if (
        part + 2 < parts.length
        && parts[part].length >= 18
        && parts[part + 1].length >= 18
        && parts[part + 2].length >= 18
      ) {
        redacted.push('[redacted-jwt]');
        part += 3;
      } else {
        redacted.push(parts[part]);
        part += 1;
      }
    }
    chunks.push(redacted.join('.'));
    index = end;
  }
  return chunks.join('');
}

function safeMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error || '未知错误');
  const truncated = rawMessage.length > MAX_SAFE_MESSAGE_CHARS;
  const message = rawMessage.slice(0, MAX_SAFE_MESSAGE_CHARS)
    .replace(LABELED_CREDENTIAL_PATTERN, '$1$2$1$3[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
  const redacted = redactJwtLikeTokens(message);
  return truncated ? `${redacted}… [truncated]` : redacted;
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

export function providerConfigurationFingerprint(provider) {
  if (!provider) return '';
  const material = JSON.stringify([
    provider.id,
    provider.name,
    provider.websiteUrl,
    provider.apiKey,
    provider.apiBaseUrl,
    provider.baseUrl,
    provider.auth,
    provider.usage,
  ]);
  return crypto.createHash('sha256').update(material).digest('base64url');
}

function safeUsage(payload) {
  if (!payload || payload.status !== 'ok') return null;
  const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    providerName: String(payload.providerName || ''),
    extra: payload.extra ? safeMessage(payload.extra) : '',
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
    this.browserConcurrency = Math.max(1, Math.min(this.concurrency, Number(options.browserConcurrency) || 1));
    this.now = options.now || Date.now;
    this.items = new Map();
    this.providers = new Map();
    this.refreshes = new Map();
    this.refreshAllPromise = null;
    this.cacheBatchDepth = 0;
    this.cacheDirty = false;
    this.revision = 0;
    this.providerSnapshot = null;
    this.publicProvidersCache = null;
    this.lastFullRefreshAt = '';
    this.lastFullRefreshDurationMs = null;
    this.cachedItems = readCache(this.cachePath);
    try { this.syncProviders(); } catch {}
  }

  syncProviders() {
    const providers = this.repository.getAll();
    if (providers === this.providerSnapshot) return { changed: false, providers };
    const activeIds = new Set();
    for (const provider of providers) {
      activeIds.add(provider.id);
      this.providers.set(provider.id, provider);
      const loginConfig = loginConfiguration(provider);
      const livePrevious = this.items.get(provider.id);
      const savedPrevious = livePrevious || this.cachedItems[provider.id] || {};
      const providerFingerprint = providerConfigurationFingerprint(provider);
      const hasSavedState = Boolean(savedPrevious.id || savedPrevious.usage || savedPrevious.status);
      const configurationChanged = hasSavedState
        && String(savedPrevious.providerFingerprint || '') !== providerFingerprint;
      const previous = configurationChanged ? {} : savedPrevious;
      const obsoleteSource = ['legacy_bridge', 'usage_script', 'ccswitch_cookie'].includes(String(previous.source || ''))
        || (Boolean(loginConfig?.userHeader) && previous.source === 'api_key_probe');
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
      const websiteLoginRequired = previous.websiteLoginRequired === true;
      const sessionSyncRequired = Boolean(
        !websiteLoginRequired
        && (previous.sessionSyncRequired || (restoredBrowserFailure && loginConfig?.userHeader))
      );
      const lastSuccessAt = String(previous.lastSuccessAt || previous.usage?.updatedAt || (previous.usage ? previous.updatedAt : '') || '');
      const lastAttemptAt = String(previous.lastAttemptAt || previous.updatedAt || '');
      this.items.set(provider.id, {
        id: provider.id,
        providerFingerprint,
        name: provider.name,
        websiteUrl: safeWebsiteUrl(provider.websiteUrl),
        current: provider.isCurrent,
        status: configurationChanged || previous.status === 'loading' || obsoleteSource ? 'idle' : (staleBrowserFailure ? 'degraded' : (previous.status || 'idle')),
        message: configurationChanged
          ? '供应商配置已变更，等待重新查询'
          : obsoleteSource
          ? '等待 v2 独立余额中心重新查询'
          : restoredBrowserFailure
            ? (websiteLoginRequired
              ? '显示上次成功余额；请点击“去官网认证”，完成后手动刷新'
              : sessionSyncRequired
              ? '显示上次成功余额；请点击“同步现有会话”一次'
              : '显示上次成功余额；请手动重新登录后刷新')
            : String(previous.message || ''),
        source: configurationChanged ? '' : (obsoleteSource ? 'cached_previous' : String(previous.source || '')),
        loginSupported: Boolean(loginConfig),
        loginUrl: safeWebsiteUrl(loginConfig?.loginUrl),
        sessionSyncSupported: Boolean(loginConfig?.userHeader),
        sessionSyncRequired,
        websiteLoginRequired,
        queryMethod: describeProviderQuery(provider),
        usage: previous.usage || null,
        updatedAt: lastSuccessAt,
        lastSuccessAt,
        lastAttemptAt,
        queryDurationMs: Number.isFinite(Number(previous.queryDurationMs))
          ? Math.max(0, Number(previous.queryDurationMs))
          : null,
      });
    }
    for (const id of this.items.keys()) {
      if (!activeIds.has(id)) {
        this.items.delete(id);
        this.providers.delete(id);
      }
    }
    this.cachedItems = {};
    this.providerSnapshot = providers;
    this.publicProvidersCache = null;
    this.revision += 1;
    return { changed: true, providers };
  }

  getState() {
    return {
      version: 2,
      revision: this.revision,
      refreshing: this.refreshes.size > 0,
      lastFullRefreshAt: this.lastFullRefreshAt,
      lastFullRefreshDurationMs: this.lastFullRefreshDurationMs,
      providers: [...this.items.values()].map(item => {
        const { providerFingerprint: _providerFingerprint, ...publicItem } = item;
        return { ...publicItem, refreshing: this.refreshes.has(item.id) };
      }),
    };
  }

  findProvider(selector) {
    const key = String(selector || '').trim().toLowerCase();
    if (!key) return null;
    if (this.providers.has(key)) return this.providers.get(key);
    return [...this.providers.values()].find(provider => providerAliases(provider).includes(key)) || null;
  }

  listPublicProviders() {
    if (this.publicProvidersCache) return this.publicProvidersCache;
    this.publicProvidersCache = [...this.providers.values()].map(provider => {
      const loginConfig = loginConfiguration(provider);
      return {
        id: provider.id,
        name: provider.name,
        aliases: providerAliases(provider),
        current: provider.isCurrent,
        loginSupported: Boolean(loginConfig),
        loginUrl: safeWebsiteUrl(loginConfig?.loginUrl),
        sessionSyncSupported: Boolean(loginConfig?.userHeader),
        queryMethod: describeProviderQuery(provider),
        balanceUrl: `/v1/balance/${encodeURIComponent(provider.id)}`,
      };
    });
    return this.publicProvidersCache;
  }

  refreshProvider(providerSelector) {
    const resolved = this.findProvider(providerSelector);
    if (!resolved) return Promise.reject(new Error('CCSwitch 中不存在这个 Codex 供应商'));
    const id = resolved.id;
    const activeRefresh = this.refreshes.get(id);
    if (activeRefresh) {
      if (activeRefresh.provider === resolved) return activeRefresh.promise;
      return activeRefresh.promise.catch(() => null).then(() => this.refreshProvider(id));
    }
    const provider = resolved;
    const previous = this.items.get(id);
    const queryStartedAt = this.now();
    this.items.set(id, { ...previous, status: previous.usage ? previous.status : 'loading', message: '' });
    this.revision += 1;
    const refresh = { provider, promise: null };
    const isCurrentSnapshot = () => this.providers.get(id) === provider && this.items.has(id);
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.queryEngine.query(provider);
        if (!isCurrentSnapshot()) return this.items.get(id) || null;
        const attemptedAt = new Date(this.now()).toISOString();
        const usage = safeUsage(result.usage);
        const targets = usage && providerKind(provider) === 'anyrouter'
          ? [...this.providers.values()].filter(candidate => providerKind(candidate) === 'anyrouter')
          : [provider];
        for (const target of targets) {
          if (this.providers.get(target.id) !== target || !this.items.has(target.id)) continue;
          const current = this.items.get(target.id);
          const targetUsage = usage && target.id !== id && usage.providerName === provider.name
            ? { ...usage, providerName: target.name }
            : usage;
          const lastSuccessAt = String(targetUsage?.updatedAt || current.lastSuccessAt || current.usage?.updatedAt || current.updatedAt || '');
          this.items.set(target.id, {
            ...current,
            status: targetUsage ? (result.degraded ? 'degraded' : 'ok') : (result.loginRequired ? 'login-required' : 'error'),
            message: targetUsage
              ? (result.degraded
                ? safeMessage(result.message || 'API 可用性检查未通过，显示本地统计')
                : '')
              : safeMessage(result.message || '没有返回可显示的额度数据'),
            source: String(result.source || ''),
            sessionSyncRequired: result.sessionSyncRequired === true,
            websiteLoginRequired: result.websiteLoginRequired === true,
            usage: targetUsage || current.usage,
            updatedAt: lastSuccessAt,
            lastSuccessAt,
            lastAttemptAt: attemptedAt,
            queryDurationMs: Math.max(0, this.now() - queryStartedAt),
          });
        }
      } catch (error) {
        if (!isCurrentSnapshot()) return this.items.get(id) || null;
        const previous = this.items.get(id);
        const message = safeMessage(error);
        const lastSuccessAt = String(previous.lastSuccessAt || previous.usage?.updatedAt || previous.updatedAt || '');
        const next = {
          ...previous,
          status: previous.usage ? 'degraded' : 'error',
          message: previous.usage ? `最近查询失败：${message}` : message,
          updatedAt: lastSuccessAt,
          lastSuccessAt,
          lastAttemptAt: new Date(this.now()).toISOString(),
        };
        this.items.set(id, next);
      } finally {
        if (isCurrentSnapshot()) {
          this.items.set(id, {
            ...this.items.get(id),
            queryDurationMs: Math.max(0, this.now() - queryStartedAt),
          });
          this.revision += 1;
          this.#writeCache();
        }
        if (this.refreshes.get(id) === refresh) this.refreshes.delete(id);
      }
      return this.items.get(id) || null;
    });
    refresh.promise = promise;
    this.refreshes.set(id, refresh);
    return promise;
  }

  refreshAll() {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.syncProviders();
    const ids = [...this.providers.keys()];
    this.refreshAllPromise = (async () => {
      const refreshStartedAt = this.now();
      this.cacheBatchDepth += 1;
      const runPool = async (poolIds, concurrency) => {
        let cursor = 0;
        const worker = async () => {
          while (cursor < poolIds.length) {
            const id = poolIds[cursor];
            cursor += 1;
            const provider = this.providers.get(id);
            if (!provider) continue;
            try {
              await this.refreshProvider(id);
            } catch (error) {
              if (this.providers.get(id) !== provider) continue;
              throw error;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, poolIds.length) }, worker));
      };
      const browserIds = ids.filter(id => this.items.get(id)?.queryMethod?.requiresBrowser === true);
      const browserIdSet = new Set(browserIds);
      const directIds = ids.filter(id => !browserIdSet.has(id));
      if (browserIds.length > 0 && directIds.length > 0 && this.concurrency > 1) {
        const browserSlots = Math.min(this.browserConcurrency, this.concurrency - 1, browserIds.length);
        const directSlots = this.concurrency - browserSlots;
        await Promise.all([
          runPool(directIds, directSlots),
          runPool(browserIds, browserSlots),
        ]);
      } else if (browserIds.length > 0 && directIds.length === 0) {
        await runPool(browserIds, this.browserConcurrency);
      } else {
        await runPool(ids, this.concurrency);
      }
      this.lastFullRefreshAt = new Date(this.now()).toISOString();
      this.lastFullRefreshDurationMs = Math.max(0, this.now() - refreshStartedAt);
      this.revision += 1;
      return this.getState();
    })().finally(() => {
      this.cacheBatchDepth = Math.max(0, this.cacheBatchDepth - 1);
      if (this.cacheDirty) this.#writeCache();
      this.refreshAllPromise = null;
    });
    return this.refreshAllPromise;
  }

  async queryBalance(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) return { success: false, message: `Unknown provider: ${String(providerSelector || '')}` };
    const item = await this.refreshProvider(provider.id);
    if (!item) {
      return {
        success: false,
        provider: provider.id,
        message: '供应商在余额查询期间已变更',
        login_required: false,
      };
    }
    return this.#balanceResponse(item);
  }

  getBalance(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) return { success: false, message: `Unknown provider: ${String(providerSelector || '')}`, cache_only: true };
    const item = this.items.get(provider.id);
    return {
      ...this.#balanceResponse(item),
      cache_only: true,
      last_success_at: item?.lastSuccessAt || item?.usage?.updatedAt || '',
      last_attempt_at: item?.lastAttemptAt || '',
    };
  }

  async queryAllBalances() {
    await this.refreshAll();
    return {
      success: [...this.items.values()].every(item => ['ok', 'degraded'].includes(item.status)),
      data: Object.fromEntries([...this.items.values()].map(item => [item.id, this.#balanceResponse(item)])),
    };
  }

  getAllBalances() {
    return {
      success: [...this.items.values()].every(item => ['ok', 'degraded'].includes(item.status)),
      cache_only: true,
      data: Object.fromEntries([...this.items.values()].map(item => [item.id, {
        ...this.#balanceResponse(item),
        cache_only: true,
        last_success_at: item.lastSuccessAt || item.usage?.updatedAt || '',
        last_attempt_at: item.lastAttemptAt || '',
      }])),
    };
  }

  async openLogin(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    const id = provider.id;
    if (!loginConfiguration(provider)) throw new Error('该供应商不支持网页登录修复');
    const action = await this.queryEngine.openLogin(provider);
    if (this.providers.get(id) !== provider || !this.items.has(id)) {
      throw new Error('供应商在登录操作期间已变更');
    }
    if (action?.synced === true) return this.refreshProvider(id);
    const item = this.items.get(id);
    this.items.set(id, {
      ...item,
      status: item.usage ? item.status : 'login-required',
      sessionSyncRequired: Boolean(item.sessionSyncSupported && !action?.opened),
      websiteLoginRequired: action?.opened === true,
      message: safeMessage(action?.message || (action?.opened
        ? '已在现有浏览器中打开登录页；登录完成后回到 Hub 手动点击刷新'
        : '未能同步现有浏览器会话，请先在官网确认登录状态')),
    });
    this.revision += 1;
    return this.items.get(id);
  }

  #balanceResponse(item) {
    if (!item) {
      return { success: false, provider: '', message: '供应商缓存不存在', login_required: false };
    }
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
    if (this.cacheBatchDepth > 0) {
      this.cacheDirty = true;
      return;
    }
    try {
      const temporary = `${this.cachePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, providers: [...this.items.values()] }), 'utf8');
      fs.renameSync(temporary, this.cachePath);
      this.cacheDirty = false;
    } catch {}
  }
}

export { safeMessage as safeHubMessage, safeUsage as sanitizeHubUsage };
