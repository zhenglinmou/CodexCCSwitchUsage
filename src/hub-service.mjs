import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  defaultBalanceTemplateId,
  describeProviderQuery,
  loginConfiguration,
  providerAliases,
  providerKind,
} from './hub-provider-adapters.mjs';
import {
  defaultRequestUsageTemplateId,
  describeProviderRequestUsage,
  normalizeRequestUsageLimit,
} from './provider-request-usage.mjs';
import {
  getBalanceTemplate,
  getRequestUsageTemplate,
  listProviderTemplates,
} from './provider-templates.mjs';

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

function localRequestNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function localRequestInteger(value, fallback = null) {
  const number = localRequestNumber(value, fallback);
  return number != null && Number.isSafeInteger(number) ? number : fallback;
}

function ccswitchRequestItem(row) {
  const inputTokens = localRequestInteger(row?.inputTokens, 0);
  const outputTokens = localRequestInteger(row?.outputTokens, 0);
  const cacheReadTokens = localRequestInteger(row?.cacheReadTokens, 0);
  const cacheCreationTokens = localRequestInteger(row?.cacheCreationTokens, 0);
  const rawStatusCode = localRequestInteger(row?.statusCode, 0);
  const statusCode = rawStatusCode > 0 ? rawStatusCode : null;
  const latencyMs = localRequestInteger(row?.latencyMs);
  const firstTokenMs = localRequestInteger(row?.firstTokenMs);
  const totalCost = localRequestNumber(row?.totalCostUsd, 0);
  const succeeded = statusCode == null || (statusCode >= 200 && statusCode < 400);

  return {
    id: '',
    requestId: '',
    upstreamRequestId: '',
    createdAt: String(row?.createdAt || ''),
    model: String(row?.model || row?.requestModel || '').slice(0, 160),
    requestModel: String(row?.requestModel || '').slice(0, 160),
    recordType: succeeded ? 'consume' : 'error',
    recordTypeCode: succeeded ? 2 : 5,
    success: succeeded,
    statusCode,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens,
    usageReturned: inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0,
    rawQuota: null,
    totalCost,
    costUnit: 'USD',
    costExact: false,
    costSource: 'ccswitch_local',
    durationSeconds: latencyMs == null ? 0 : Number((latencyMs / 1_000).toFixed(3)),
    latencyMs,
    firstTokenMs,
    isStream: false,
    billingSource: 'ccswitch_local_multiplier',
    requestPath: '',
  };
}

function ccswitchRequestUsageFallback(provider, rows, remoteResult, limit, now) {
  const fallbackReason = safeMessage(remoteResult?.message || '第三方真实逐请求扣费接口不可用');
  const warning = 'CCSwitch 本地费用按其模型价格和倍率计算；第三方倍率不同时可能与账户实际扣费不一致';
  const items = rows.slice(0, limit).map(ccswitchRequestItem);
  return {
    success: true,
    supported: true,
    remoteSupported: remoteResult?.supported === true,
    preciseCostAvailable: false,
    providerId: String(provider.id || ''),
    providerName: String(provider.name || '供应商'),
    providerKind: providerKind(provider),
    appType: 'codex',
    source: 'ccswitch_local',
    remoteSource: String(remoteResult?.source || ''),
    interface: remoteResult?.interface || describeProviderRequestUsage(provider),
    limit,
    fetchedAt: new Date(now()).toISOString(),
    fallback: true,
    degraded: true,
    fallbackReason,
    message: `未能取得第三方真实逐请求扣费，已回退 CCSwitch 本地估算：${fallbackReason}`,
    requestCount: items.length,
    totalLocalRecords: items.length,
    billing: {
      available: true,
      exact: false,
      displayType: 'USD',
      unit: 'USD',
      quotaPerUnit: null,
      multiplier: 1,
      source: 'ccswitch_local',
      warning,
    },
    ...(remoteResult?.httpStatus != null ? { remoteHttpStatus: remoteResult.httpStatus } : {}),
    ...(remoteResult?.errorType ? { remoteErrorType: String(remoteResult.errorType) } : {}),
    items,
  };
}

export function providerConfigurationFingerprint(provider, templateSelection = null) {
  if (!provider) return '';
  const fields = [
    provider.id,
    provider.name,
    provider.websiteUrl,
    provider.apiKey,
    provider.apiBaseUrl,
    provider.baseUrl,
    provider.auth,
    provider.usage,
  ];
  if (templateSelection && (
    templateSelection.balanceSource === 'manual'
    || templateSelection.requestUsageSource === 'manual'
  )) {
    fields.push(
      String(templateSelection.balanceTemplateId || ''),
      String(templateSelection.balanceSource || ''),
      String(templateSelection.requestUsageTemplateId || ''),
      String(templateSelection.requestUsageSource || ''),
    );
  }
  const material = JSON.stringify(fields);
  return crypto.createHash('sha256').update(material).digest('base64url');
}

function selectedTemplateOption(selection, type) {
  if (!selection || selection[`${type}Source`] !== 'manual') return '';
  return String(selection[`${type}TemplateId`] || '');
}

function templateSelectionFor(provider, templateStore) {
  const binding = templateStore?.get?.(provider) || null;
  const manualBalance = getBalanceTemplate(binding?.balanceTemplateId)?.selectable === true
    ? String(binding.balanceTemplateId)
    : '';
  const manualRequestUsage = getRequestUsageTemplate(binding?.requestUsageTemplateId)?.selectable === true
    ? String(binding.requestUsageTemplateId)
    : '';
  return {
    balanceTemplateId: manualBalance || defaultBalanceTemplateId(provider),
    balanceSource: manualBalance ? 'manual' : 'builtin',
    requestUsageTemplateId: manualRequestUsage || defaultRequestUsageTemplateId(provider),
    requestUsageSource: manualRequestUsage ? 'manual' : 'builtin',
    updatedAt: binding?.updatedAt || '',
  };
}

function safeProbeUsage(usage, source = '') {
  if (!usage || typeof usage !== 'object') return null;
  const finiteOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    providerName: String(usage.providerName || '').slice(0, 80),
    remaining: finiteOrNull(usage.remaining),
    used: finiteOrNull(usage.used),
    total: finiteOrNull(usage.total),
    unit: String(usage.unit || '').slice(0, 24),
    source: String(source || '').slice(0, 80),
  };
}

function safeHttpsOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

function safeAccountBinding(value) {
  if (!value || typeof value !== 'object') return null;
  const clientRef = String(value.clientRef || '').trim();
  const browser = String(value.browser || '').replace(/\s+/g, ' ').trim().slice(0, 64);
  const origin = String(value.origin || '').trim();
  const accountRef = String(value.accountRef || '').trim();
  const boundAt = String(value.boundAt || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientRef)) return null;
  if (!browser || origin !== 'https://anyrouter.top') return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(accountRef)) return null;
  return {
    clientRef,
    browser,
    origin,
    accountRef,
    boundAt: Number.isFinite(Date.parse(boundAt)) ? new Date(boundAt).toISOString() : '',
  };
}

function publicAccountBinding(value) {
  const binding = safeAccountBinding(value);
  return binding ? { clientRef: binding.clientRef, browser: binding.browser } : null;
}

function sameAnyRouterCredential(left, right) {
  const apiKey = String(left?.apiKey || '');
  return Boolean(apiKey && apiKey === String(right?.apiKey || ''));
}

function sameAccountBinding(left, right) {
  const first = safeAccountBinding(left);
  const second = safeAccountBinding(right);
  if (!first || !second) return !first && !second;
  return first.clientRef === second.clientRef
    && first.origin === second.origin
    && first.accountRef === second.accountRef;
}

function safeUsage(payload) {
  if (!payload || payload.status !== 'ok') return null;
  const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    providerName: String(payload.providerName || ''),
    accountBrowser: String(payload.accountBrowser || '').replace(/\s+/g, ' ').trim().slice(0, 64),
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
      providerDisplayName: String(provider.name || usage.providerName || '供应商'),
      providerName: usage.providerName || provider.name,
      accountBrowser: usage.accountBrowser || '',
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
    providerDisplayName: String(provider.name || '供应商'),
    providerName: provider.name,
    accountBrowser: '',
    websiteUrl: provider.websiteUrl,
    message: String(item?.message || 'Balance Hub 尚未返回额度'),
    updatedAt: item?.updatedAt || new Date().toISOString(),
  };
}

export class HubService {
  constructor(repository, queryEngine, options = {}) {
    this.repository = repository;
    this.queryEngine = queryEngine;
    this.requestUsageEngine = options.requestUsageEngine || null;
    this.templateStore = options.templateStore || null;
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
      const templateSelection = templateSelectionFor(provider, this.templateStore);
      const balanceTemplateOption = selectedTemplateOption(templateSelection, 'balance');
      const loginConfig = loginConfiguration(provider, balanceTemplateOption);
      const livePrevious = this.items.get(provider.id);
      const savedPrevious = livePrevious || this.cachedItems[provider.id] || {};
      const providerFingerprint = providerConfigurationFingerprint(provider, templateSelection);
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
      const accountBinding = configurationChanged ? null : safeAccountBinding(previous.accountBinding);
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
        accountBindingSupported: providerKind(provider) === 'anyrouter',
        accountBindingRequired: configurationChanged ? false : previous.accountBindingRequired === true,
        accountBinding,
        templateSelection,
        queryMethod: describeProviderQuery(provider, balanceTemplateOption),
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
      providers: [...this.items.values()].map(item => this.#publicItem(item, this.refreshes.has(item.id))),
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
      const templateSelection = templateSelectionFor(provider, this.templateStore);
      const balanceTemplateOption = selectedTemplateOption(templateSelection, 'balance');
      const loginConfig = loginConfiguration(provider, balanceTemplateOption);
      return {
        id: provider.id,
        name: provider.name,
        aliases: providerAliases(provider),
        current: provider.isCurrent,
        loginSupported: Boolean(loginConfig),
        loginUrl: safeWebsiteUrl(loginConfig?.loginUrl),
        sessionSyncSupported: Boolean(loginConfig?.userHeader),
        accountBindingSupported: providerKind(provider) === 'anyrouter',
        templateSelection,
        queryMethod: describeProviderQuery(provider, balanceTemplateOption),
        balanceUrl: `/v1/balance/${encodeURIComponent(provider.id)}`,
      };
    });
    return this.publicProvidersCache;
  }

  listTemplates(providerSelector = '') {
    const catalog = listProviderTemplates();
    if (!providerSelector) return catalog;
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    return {
      ...catalog,
      providerId: provider.id,
      selection: this.items.get(provider.id)?.templateSelection || templateSelectionFor(provider, this.templateStore),
    };
  }

  saveTemplateSelection(providerSelector, selection = {}) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    if (!this.templateStore?.set) throw new Error('当前 Hub 没有启用模板绑定存储');
    const currentBinding = this.templateStore.get?.(provider) || null;
    const hasBalance = Object.prototype.hasOwnProperty.call(selection, 'balanceTemplateId');
    const hasRequestUsage = Object.prototype.hasOwnProperty.call(selection, 'requestUsageTemplateId');
    const balanceTemplateId = hasBalance
      ? String(selection.balanceTemplateId || '')
      : String(currentBinding?.balanceTemplateId || '');
    const requestUsageTemplateId = hasRequestUsage
      ? String(selection.requestUsageTemplateId || '')
      : String(currentBinding?.requestUsageTemplateId || '');
    if (balanceTemplateId && getBalanceTemplate(balanceTemplateId)?.selectable !== true) {
      throw new Error('这个余额模板不能手动绑定');
    }
    if (requestUsageTemplateId && getRequestUsageTemplate(requestUsageTemplateId)?.selectable !== true) {
      throw new Error('这个逐请求用量模板不能手动绑定');
    }
    this.templateStore.set(provider, { balanceTemplateId, requestUsageTemplateId });
    return this.#resyncTemplateProvider(provider);
  }

  clearTemplateSelection(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    if (!this.templateStore?.clear) throw new Error('当前 Hub 没有启用模板绑定存储');
    this.templateStore.clear(provider.id);
    return this.#resyncTemplateProvider(provider);
  }

  async probeTemplates(providerSelector, options = {}) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    const selection = this.items.get(provider.id)?.templateSelection || templateSelectionFor(provider, this.templateStore);
    const requestedBalance = String(options.balanceTemplateId || '');
    const requestedRequestUsage = String(options.requestUsageTemplateId || '');
    if (requestedBalance && getBalanceTemplate(requestedBalance)?.selectable !== true) {
      throw new Error('这个余额模板不能手动测试');
    }
    if (requestedRequestUsage && getRequestUsageTemplate(requestedRequestUsage)?.selectable !== true) {
      throw new Error('这个逐请求用量模板不能手动测试');
    }

    // Packy-style responses are a more specific New API capability and overlap the standard token schema.
    const balanceOrder = ['packy-balance', 'new-api-key-quota', 'deepseek-balance', 'window-balance', 'new-api-browser-account'];
    const currentBalance = getBalanceTemplate(selection.balanceTemplateId);
    const preferredBalance = currentBalance?.autoDetect
      ? selection.balanceTemplateId === 'new-api-key-quota'
        ? ['packy-balance', selection.balanceTemplateId]
        : [selection.balanceTemplateId]
      : [];
    const balanceCandidates = requestedBalance
      ? [requestedBalance]
      : currentBalance?.selectable !== true
        ? [selection.balanceTemplateId]
        : [...new Set([
            ...preferredBalance,
            ...balanceOrder.filter(id => getBalanceTemplate(id)?.autoDetect),
          ])];
    const balanceResults = [];
    let balanceTemplateId = '';
    for (const templateId of balanceCandidates) {
      const useBuiltin = selection.balanceSource === 'builtin'
        && selection.balanceTemplateId === templateId;
      const result = await this.#probeBalanceTemplate(provider, templateId, { useBuiltin });
      balanceResults.push(result);
      if (result.status === 'success') {
        balanceTemplateId = templateId;
        break;
      }
    }
    let fallbackBalanceTemplateId = '';
    if (!requestedBalance && !balanceTemplateId) {
      const fallback = await this.#probeBalanceTemplate(provider, 'api-health-local');
      balanceResults.push(fallback);
      if (fallback.status === 'success') fallbackBalanceTemplateId = 'api-health-local';
    }

    const requestCandidates = requestedRequestUsage
      ? [requestedRequestUsage]
      : ['new-api-token-log'];
    const requestUsageResults = [];
    let requestUsageTemplateId = '';
    for (const templateId of requestCandidates) {
      const useBuiltin = selection.requestUsageSource === 'builtin'
        && selection.requestUsageTemplateId === templateId;
      const result = await this.#probeRequestUsageTemplate(provider, templateId, { useBuiltin });
      requestUsageResults.push(result);
      if (result.status === 'success') {
        requestUsageTemplateId = templateId;
        break;
      }
    }
    if (!requestedRequestUsage && !requestUsageTemplateId) {
      const fallback = await this.#probeRequestUsageTemplate(provider, 'ccswitch-local');
      requestUsageResults.push(fallback);
      if (fallback.status === 'success') requestUsageTemplateId = 'ccswitch-local';
    }

    return {
      success: Boolean(balanceTemplateId || fallbackBalanceTemplateId || requestUsageTemplateId),
      providerId: provider.id,
      testedAt: new Date(this.now()).toISOString(),
      balance: {
        recommendedTemplateId: balanceTemplateId,
        fallbackTemplateId: fallbackBalanceTemplateId,
        results: balanceResults,
      },
      requestUsage: {
        recommendedTemplateId: requestUsageTemplateId,
        results: requestUsageResults,
      },
    };
  }

  listBrowserOrigins() {
    const origins = new Set();
    for (const provider of this.providers.values()) {
      const selection = this.items.get(provider.id)?.templateSelection || templateSelectionFor(provider, this.templateStore);
      const balanceOption = selectedTemplateOption(selection, 'balance');
      const requestOption = selectedTemplateOption(selection, 'requestUsage');
      const loginConfig = loginConfiguration(provider, balanceOption);
      const queryMethod = describeProviderQuery(provider, balanceOption);
      const requestMethod = describeProviderRequestUsage(provider, requestOption);
      for (const value of [
        loginConfig?.baseUrl,
        loginConfig?.loginUrl,
        ...(queryMethod?.requiresBrowser === true || queryMethod?.waf === true ? [queryMethod?.requestUrl] : []),
        ...(requestMethod?.requiresBrowser === true
          ? [requestMethod?.requestUrl, requestMethod?.configurationUrl]
          : []),
      ]) {
        const origin = safeHttpsOrigin(value);
        if (origin) origins.add(origin);
      }
    }
    return [...origins].sort();
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
    const refreshFingerprint = String(previous?.providerFingerprint || '');
    const queryStartedAt = this.now();
    this.items.set(id, { ...previous, status: previous.usage ? previous.status : 'loading', message: '' });
    this.revision += 1;
    const refresh = { provider, promise: null };
    const isCurrentSnapshot = () => this.providers.get(id) === provider
      && this.items.has(id)
      && String(this.items.get(id)?.providerFingerprint || '') === refreshFingerprint;
    const promise = Promise.resolve().then(async () => {
      try {
        const anyRouterCredentials = providerKind(provider) === 'anyrouter'
          ? new Set([...this.providers.values()]
              .filter(candidate => providerKind(candidate) === 'anyrouter')
              .map(candidate => String(candidate.apiKey || candidate.id || '')))
          : null;
        const result = await this.queryEngine.query(provider, {
          accountBinding: previous.accountBinding || null,
          allowSoleSessionFallback: !anyRouterCredentials || anyRouterCredentials.size <= 1,
          ...(selectedTemplateOption(previous.templateSelection, 'balance')
            ? { balanceTemplateId: selectedTemplateOption(previous.templateSelection, 'balance') }
            : {}),
        });
        if (!isCurrentSnapshot()) return this.items.get(id) || null;
        const attemptedAt = new Date(this.now()).toISOString();
        const usage = safeUsage(result.usage);
        const targets = providerKind(provider) === 'anyrouter'
          ? [...this.providers.values()].filter(candidate => {
              if (candidate.id === provider.id) return true;
              if (providerKind(candidate) !== 'anyrouter' || !sameAnyRouterCredential(provider, candidate)) return false;
              const candidateSelection = this.items.get(candidate.id)?.templateSelection;
              if (candidateSelection?.balanceTemplateId !== previous.templateSelection?.balanceTemplateId
                || candidateSelection?.balanceSource !== previous.templateSelection?.balanceSource) return false;
              return sameAccountBinding(previous.accountBinding, this.items.get(candidate.id)?.accountBinding);
            })
          : [provider];
        for (const target of targets) {
          if (this.providers.get(target.id) !== target || !this.items.has(target.id)) continue;
          const current = this.items.get(target.id);
          const targetUsage = usage && target.id !== id && usage.providerName === provider.name
            ? { ...usage, providerName: target.name }
            : usage;
          const nextUsage = result.invalidateUsage === true ? null : (targetUsage || current.usage);
          const lastSuccessAt = result.invalidateUsage === true
            ? ''
            : String(targetUsage?.updatedAt || current.lastSuccessAt || current.usage?.updatedAt || current.updatedAt || '');
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
            accountBindingRequired: result.accountBindingRequired === true,
            usage: nextUsage,
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
      const browserIds = ids.filter(id => {
        const method = this.items.get(id)?.queryMethod;
        return method?.requiresBrowser === true || method?.type === 'api-key-with-account-fallback';
      });
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

  async queryRequestUsage(providerSelector, options = {}) {
    const provider = this.findProvider(providerSelector);
    if (!provider) {
      return {
        success: false,
        notFound: true,
        message: `Unknown provider: ${String(providerSelector || '')}`,
      };
    }
    const limit = normalizeRequestUsageLimit(options.limit);
    const templateSelection = this.items.get(provider.id)?.templateSelection || templateSelectionFor(provider, this.templateStore);
    const requestUsageTemplateOption = selectedTemplateOption(templateSelection, 'requestUsage');
    let credentialAppTypes = ['codex'];
    try {
      if (typeof this.repository?.getCredentialAppTypes === 'function') {
        credentialAppTypes = this.repository.getCredentialAppTypes(provider.apiKey);
      }
    } catch {}
    const sharedAcrossApps = credentialAppTypes.some(appType => appType !== 'codex');
    let remoteResult;
    if (!this.requestUsageEngine || typeof this.requestUsageEngine.query !== 'function') {
      remoteResult = {
        success: false,
        supported: false,
        providerId: provider.id,
        providerName: provider.name,
        providerKind: providerKind(provider),
        source: 'unavailable',
        interface: describeProviderRequestUsage(provider, requestUsageTemplateOption),
        limit,
        fetchedAt: new Date(this.now()).toISOString(),
        items: [],
        message: '第三方真实逐请求扣费接口尚未启用',
      };
    } else {
      try {
        remoteResult = await this.requestUsageEngine.query(provider, {
          ...options,
          limit,
          appType: 'codex',
          strictAppType: sharedAcrossApps,
          ...(requestUsageTemplateOption ? { requestUsageTemplateId: requestUsageTemplateOption } : {}),
        });
      } catch (error) {
        remoteResult = {
          success: false,
          supported: true,
          providerId: provider.id,
          providerName: provider.name,
          providerKind: providerKind(provider),
          source: 'provider_log',
          interface: describeProviderRequestUsage(provider, requestUsageTemplateOption),
          limit,
          fetchedAt: new Date(this.now()).toISOString(),
          items: [],
          errorType: 'provider',
          message: safeMessage(error),
        };
      }
    }
    if (remoteResult?.success === true) {
      return {
        ...remoteResult,
        appType: 'codex',
        credentialSharedAcrossApps: sharedAcrossApps,
        fallback: false,
        preciseCostAvailable: remoteResult?.billing?.exact === true,
      };
    }
    if (typeof this.repository?.getRecentRequests !== 'function') return remoteResult;
    try {
      const rows = this.repository.getRecentRequests(provider.id, limit);
      if (!Array.isArray(rows)) return remoteResult;
      return ccswitchRequestUsageFallback(provider, rows, remoteResult, limit, this.now);
    } catch (error) {
      return {
        ...remoteResult,
        fallback: false,
        fallbackError: safeMessage(error),
      };
    }
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

  async bindAccount(providerSelector, options = {}) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    if (providerKind(provider) !== 'anyrouter') throw new Error('只有 AnyRouter 支持显式浏览器账号绑定');
    if (typeof this.queryEngine?.bindBrowserAccount !== 'function') throw new Error('当前余额适配器不支持浏览器账号绑定');
    const result = await this.queryEngine.bindBrowserAccount(provider, { clientRef: String(options.clientRef || '').trim() });
    if (result?.failure) {
      return {
        ...this.#publicItem(this.items.get(provider.id)),
        bindingAttemptFailed: true,
        message: safeMessage(result.failure.message || 'AnyRouter 账号绑定失败'),
      };
    }
    const binding = safeAccountBinding(result?.binding);
    if (!binding) throw new Error('AnyRouter 账号绑定结果无效');
    const targets = [...this.providers.values()].filter(candidate => (
      providerKind(candidate) === 'anyrouter'
      && (candidate.id === provider.id || sameAnyRouterCredential(provider, candidate))
    ));
    for (const target of targets) {
      const current = this.items.get(target.id);
      if (!current) continue;
      this.items.set(target.id, {
        ...current,
        accountBinding: binding,
        accountBindingRequired: false,
        status: 'idle',
        message: `已绑定 ${binding.browser} AnyRouter 账号，等待刷新`,
        source: '',
        usage: null,
        updatedAt: '',
        lastSuccessAt: '',
        lastAttemptAt: '',
      });
    }
    this.revision += 1;
    this.#writeCache();
    await this.refreshProvider(provider.id);
    return this.#publicItem(this.items.get(provider.id));
  }

  clearAccountBinding(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    if (providerKind(provider) !== 'anyrouter') throw new Error('只有 AnyRouter 支持显式浏览器账号绑定');
    const selected = this.items.get(provider.id);
    const targets = [...this.providers.values()].filter(candidate => (
      providerKind(candidate) === 'anyrouter'
      && (candidate.id === provider.id || (
        sameAnyRouterCredential(provider, candidate)
        && sameAccountBinding(selected?.accountBinding, this.items.get(candidate.id)?.accountBinding)
      ))
    ));
    for (const target of targets) {
      const current = this.items.get(target.id);
      if (!current) continue;
      this.items.set(target.id, {
        ...current,
        accountBinding: null,
        accountBindingRequired: false,
        status: 'idle',
        message: 'AnyRouter 浏览器账号绑定已解除',
        source: '',
        usage: null,
        updatedAt: '',
        lastSuccessAt: '',
        lastAttemptAt: '',
      });
    }
    this.revision += 1;
    this.#writeCache();
    return this.#publicItem(this.items.get(provider.id));
  }

  async openLogin(providerSelector, options = {}) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    const id = provider.id;
    const templateSelection = this.items.get(id)?.templateSelection || templateSelectionFor(provider, this.templateStore);
    const balanceTemplateId = selectedTemplateOption(templateSelection, 'balance');
    if (!loginConfiguration(provider, balanceTemplateId)) throw new Error('该供应商不支持网页登录修复');
    const action = await this.queryEngine.openLogin(provider, {
      ...options,
      ...(balanceTemplateId ? { balanceTemplateId } : {}),
    });
    if (this.providers.get(id) !== provider || !this.items.has(id)) {
      throw new Error('供应商在登录操作期间已变更');
    }
    if (action?.synced === true) {
      await this.refreshProvider(id);
      return this.#publicItem(this.items.get(id));
    }
    const item = this.items.get(id);
    this.items.set(id, {
      ...item,
      status: item.usage ? item.status : 'login-required',
      sessionSyncRequired: Boolean(item.sessionSyncSupported && !action?.opened),
      websiteLoginRequired: action?.opened === true,
      message: safeMessage(action?.message || (action?.opened
        ? `已在${action?.browser ? ` ${action.browser} 浏览器` : '现有浏览器'}中打开登录页；登录完成后回到 Hub 手动点击刷新`
        : '未能同步现有浏览器会话，请先在官网确认登录状态')),
    });
    this.revision += 1;
    return this.#publicItem(this.items.get(id));
  }

  #resyncTemplateProvider(provider) {
    this.refreshes.delete(provider.id);
    this.providerSnapshot = null;
    this.publicProvidersCache = null;
    this.requestUsageEngine?.clearStatusCache?.();
    this.syncProviders();
    this.#writeCache();
    return this.#publicItem(this.items.get(provider.id));
  }

  async #probeBalanceTemplate(provider, templateId, options = {}) {
    const template = getBalanceTemplate(templateId);
    const base = {
      templateId,
      label: String(template?.label || templateId),
      status: 'failed',
      message: '',
      preview: null,
    };
    if (!template) return { ...base, message: '余额模板不存在' };
    try {
      const result = await this.queryEngine.query(provider, {
        ...(options.useBuiltin === true ? {} : { balanceTemplateId: templateId }),
        bypassCache: true,
        timeoutMs: 8_000,
        accountBinding: this.items.get(provider.id)?.accountBinding || null,
      });
      const source = String(result?.source || '');
      const localFallback = result?.degraded === true
        || source === 'muyuan_local_usage'
        || source === 'api_health_and_local_usage';
      const usage = safeProbeUsage(result?.usage, source);
      if (usage && (!localFallback || templateId === 'api-health-local')) {
        return { ...base, status: 'success', message: '调用成功', preview: usage };
      }
      const needsAction = result?.loginRequired === true
        || result?.sessionSyncRequired === true
        || result?.websiteLoginRequired === true
        || result?.accountBindingRequired === true;
      return {
        ...base,
        status: needsAction ? 'needs-action' : 'failed',
        message: safeMessage(result?.message || (localFallback ? '只取得本地回退数据，未验证远端额度结构' : '没有返回可验证的额度数据')),
      };
    } catch (error) {
      return { ...base, message: safeMessage(error) };
    }
  }

  async #probeRequestUsageTemplate(provider, templateId, options = {}) {
    const template = getRequestUsageTemplate(templateId);
    const base = {
      templateId,
      label: String(template?.label || templateId),
      status: 'failed',
      message: '',
      preview: null,
    };
    if (!template) return { ...base, message: '逐请求用量模板不存在' };
    if (templateId === 'ccswitch-local') {
      try {
        const rows = typeof this.repository?.getRecentRequests === 'function'
          ? this.repository.getRecentRequests(provider.id, 10)
          : [];
        const requestCount = Array.isArray(rows) ? rows.length : 0;
        return {
          ...base,
          status: 'success',
          message: '本地请求记录可用',
          preview: { requestCount, source: 'ccswitch_local', costExact: false },
        };
      } catch (error) {
        return { ...base, message: safeMessage(error) };
      }
    }
    if (!this.requestUsageEngine?.query) return { ...base, message: '第三方逐请求查询引擎未启用' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('逐请求模板测试超过 8 秒')), 8_000);
    try {
      const result = await this.requestUsageEngine.query(provider, {
        ...(options.useBuiltin === true ? {} : { requestUsageTemplateId: templateId }),
        bypassCache: true,
        limit: 10,
        appType: 'codex',
        signal: controller.signal,
      });
      if (result?.success === true) {
        return {
          ...base,
          status: 'success',
          message: result?.degraded ? safeMessage(result.message || '调用成功，但计费配置不完整') : '调用成功',
          preview: {
            requestCount: Math.max(0, Number(result.requestCount) || 0),
            source: String(result.source || '').slice(0, 80),
            costUnit: String(result.billing?.unit || '').slice(0, 24),
            costExact: result.billing?.exact === true,
          },
        };
      }
      return { ...base, message: safeMessage(result?.message || '没有返回可验证的逐请求日志') };
    } catch (error) {
      return { ...base, message: safeMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  #publicItem(item, refreshing = false) {
    if (!item) return null;
    const {
      providerFingerprint: _providerFingerprint,
      accountBinding: internalAccountBinding,
      ...publicItem
    } = item;
    return {
      ...publicItem,
      accountBinding: publicAccountBinding(internalAccountBinding),
      refreshing,
    };
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
