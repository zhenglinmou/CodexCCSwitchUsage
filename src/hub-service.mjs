import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
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
  PROVIDER_TEMPLATE_REGISTRY_VERSION,
} from './provider-templates.mjs';
import { secureAtomicWriteFileSync } from './secure-files.mjs';

const MAX_SAFE_MESSAGE_CHARS = 8_192;
const MAX_HUB_CACHE_BYTES = 8_000_000;
const MAX_HUB_CACHE_PROVIDERS = 1_024;
const DEFAULT_TEMPLATE_PROBE_TIMEOUT_MS = 12_000;
const DEFAULT_TEMPLATE_PROBE_SPECULATION_DELAY_MS = 100;
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

function providerSecrets(provider) {
  const values = new Set();
  const add = value => {
    const text = String(value || '');
    if (text.length >= 4 && text.length <= 32_768) values.add(text);
  };
  add(provider?.apiKey);
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /(api[_-]?key|auth(?:orization)?|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|cookie)/i.test(key)) {
        add(item);
      } else if (item && typeof item === 'object') {
        visit(item, depth + 1);
      }
    }
  };
  visit(provider?.auth);
  return [...values].sort((left, right) => right.length - left.length);
}

function sanitizedCredentialText(value, secrets = [], maximum = MAX_SAFE_MESSAGE_CHARS) {
  const rawMessage = value instanceof Error ? value.message : String(value || '');
  const truncated = rawMessage.length > MAX_SAFE_MESSAGE_CHARS;
  let message = rawMessage.slice(0, maximum);
  for (const secret of secrets) {
    const credential = String(secret || '');
    if (credential.length >= 4) message = message.split(credential).join('[redacted]');
  }
  message = message
    .replace(LABELED_CREDENTIAL_PATTERN, '$1$2$1$3[redacted]')
    .replace(/Bearer\s+(?!API\s+Key\b)[^\s,;，；]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
  const redacted = redactJwtLikeTokens(message);
  return truncated ? `${redacted}… [truncated]` : redacted;
}

function safeMessage(error, secrets = []) {
  const value = error instanceof Error ? error.message : (error == null ? '未知错误' : String(error));
  return sanitizedCredentialText(value, secrets);
}

function containsCredential(value, secrets = []) {
  const candidate = String(value || '').toLowerCase();
  return secrets.some(secret => {
    const credential = String(secret || '');
    return credential.length >= 4 && candidate.includes(credential.toLowerCase());
  });
}

function safeWebsiteUrl(value, secrets = []) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return containsCredential(url.href, secrets) ? '' : url.href;
  } catch {
    return '';
  }
}

function safeQueryUrl(value, secrets = []) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return containsCredential(url.href, secrets) ? '' : url.href;
  } catch {
    return '';
  }
}

function safeQueryMethod(value, secrets = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['requestUrl', 'configurationUrl'].includes(key)) {
      result[key] = safeQueryUrl(item, secrets);
    } else if (key === 'notes') {
      result.notes = (Array.isArray(item) ? item : [])
        .slice(0, 16)
        .map(note => sanitizedCredentialText(note, secrets, 500));
    } else if (typeof item === 'string') {
      result[key] = sanitizedCredentialText(item, secrets, 500);
    } else if (typeof item === 'boolean' || typeof item === 'number' || item == null) {
      result[key] = item;
    }
  }
  return result;
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

function createLocalRequestRowsReader(repository, providerId, minimumLimit = 10) {
  if (typeof repository?.getRecentRequests !== 'function') return null;
  let rows;
  let loadedLimit = 0;
  let readError = null;
  return requestedLimit => {
    if (readError) throw readError;
    const boundedLimit = Math.max(
      normalizeRequestUsageLimit(minimumLimit),
      normalizeRequestUsageLimit(requestedLimit),
    );
    if (rows === undefined || boundedLimit > loadedLimit) {
      try {
        rows = repository.getRecentRequests(providerId, boundedLimit);
        loadedLimit = boundedLimit;
      } catch (error) {
        readError = error;
        throw error;
      }
    }
    return rows;
  };
}

export function providerConfigurationFingerprint(provider, templateSelection = null) {
  if (!provider) return '';
  const fields = [
    PROVIDER_TEMPLATE_REGISTRY_VERSION,
    provider.id,
    provider.name,
    provider.websiteUrl,
    provider.apiKey,
    provider.apiBaseUrl,
    provider.baseUrl,
    provider.auth,
  ];
  if (templateSelection) {
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

function abortableOperation(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('操作已取消'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('操作已取消'));
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('操作已取消');
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

function safeProbeUsage(usage, source = '', secrets = []) {
  if (!usage || typeof usage !== 'object') return null;
  const finiteOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    providerName: sanitizedCredentialText(usage.providerName, secrets, 80),
    remaining: finiteOrNull(usage.remaining),
    used: finiteOrNull(usage.used),
    total: finiteOrNull(usage.total),
    unit: sanitizedCredentialText(usage.unit, secrets, 24),
    source: sanitizedCredentialText(source, secrets, 80),
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

function canonicalAnyRouterRequestProvider(provider, providers) {
  if (providerKind(provider) !== 'anyrouter') return provider;
  return [...providers].find(candidate => {
    if (providerKind(candidate) !== 'anyrouter' || !sameAnyRouterCredential(provider, candidate)) return false;
    try {
      return new URL(String(candidate.apiBaseUrl || candidate.baseUrl || '')).hostname.toLowerCase() === 'anyrouter.top';
    } catch {
      return false;
    }
  }) || provider;
}

function sameAccountBinding(left, right) {
  const first = safeAccountBinding(left);
  const second = safeAccountBinding(right);
  if (!first || !second) return !first && !second;
  return first.clientRef === second.clientRef
    && first.origin === second.origin
    && first.accountRef === second.accountRef;
}

function safeUsage(payload, secrets = []) {
  if (!payload || payload.status !== 'ok') return null;
  const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    providerName: sanitizedCredentialText(payload.providerName, secrets, 160),
    accountBrowser: sanitizedCredentialText(payload.accountBrowser, secrets, 64).replace(/\s+/g, ' ').trim(),
    extra: payload.extra ? safeMessage(payload.extra, secrets) : '',
    periodLabel: sanitizedCredentialText(payload.periodLabel, secrets, 160),
    hideTotal: payload.hideTotal === true,
    refreshIntervalMinutes: Math.max(1, Number(payload.refreshIntervalMinutes) || 5),
    used: numberOrNull(payload.used),
    remaining: numberOrNull(payload.remaining),
    total: numberOrNull(payload.total),
    unit: sanitizedCredentialText(payload.unit, secrets, 32),
    updatedAt: String(payload.updatedAt || new Date().toISOString()).slice(0, 64),
    queryError: payload.queryError ? safeMessage(payload.queryError, secrets) : '',
  };
}

function readCache(cachePath) {
  if (!cachePath) return {};
  try {
    const stats = fs.statSync(cachePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_HUB_CACHE_BYTES) return {};
    const value = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.providers)) return {};
    const entries = [];
    for (const item of value.providers.slice(0, MAX_HUB_CACHE_PROVIDERS)) {
      const id = String(item?.id || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
      if (!id || entries.some(([existing]) => existing === id)) continue;
      entries.push([id, {
        id,
        providerFingerprint: String(item.providerFingerprint || '').slice(0, 128),
        status: ['idle', 'loading', 'ok', 'degraded', 'error', 'login-required'].includes(String(item.status || ''))
          ? String(item.status)
          : 'idle',
        message: String(item.message || '').slice(0, MAX_SAFE_MESSAGE_CHARS),
        source: String(item.source || '').slice(0, 160),
        sessionSyncRequired: item.sessionSyncRequired === true,
        websiteLoginRequired: item.websiteLoginRequired === true,
        accountBindingRequired: item.accountBindingRequired === true,
        accountBinding: safeAccountBinding(item.accountBinding),
        usage: item.usage && typeof item.usage === 'object' ? { ...item.usage } : null,
        updatedAt: String(item.updatedAt || '').slice(0, 64),
        lastSuccessAt: String(item.lastSuccessAt || '').slice(0, 64),
        lastAttemptAt: String(item.lastAttemptAt || '').slice(0, 64),
        queryDurationMs: Number.isFinite(Number(item.queryDurationMs)) ? Math.max(0, Number(item.queryDurationMs)) : null,
      }]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function cacheItem(item, provider) {
  const secrets = providerSecrets(provider);
  return {
    id: String(item?.id || '').slice(0, 160),
    providerFingerprint: String(item?.providerFingerprint || '').slice(0, 128),
    status: String(item?.status || 'idle'),
    message: safeMessage(item?.message || '', secrets),
    source: sanitizedCredentialText(item?.source, secrets, 160),
    sessionSyncRequired: item?.sessionSyncRequired === true,
    websiteLoginRequired: item?.websiteLoginRequired === true,
    accountBindingRequired: item?.accountBindingRequired === true,
    accountBinding: safeAccountBinding(item?.accountBinding),
    usage: item?.usage ? safeUsage({ status: 'ok', ...item.usage }, secrets) : null,
    updatedAt: String(item?.updatedAt || '').slice(0, 64),
    lastSuccessAt: String(item?.lastSuccessAt || '').slice(0, 64),
    lastAttemptAt: String(item?.lastAttemptAt || '').slice(0, 64),
    queryDurationMs: Number.isFinite(Number(item?.queryDurationMs)) ? Math.max(0, Number(item.queryDurationMs)) : null,
  };
}

export function hubItemToUsagePayload(provider, item) {
  const secrets = providerSecrets(provider);
  const providerName = sanitizedCredentialText(provider?.name || '供应商', secrets, 160) || '供应商';
  const websiteUrl = safeWebsiteUrl(provider?.websiteUrl, secrets);
  const usage = item?.usage ? safeUsage({ status: 'ok', ...item.usage }, secrets) : null;
  if (usage) {
    const queryError = item.status === 'ok' ? '' : safeMessage(item.message || '最近一次 Hub 查询未成功', secrets);
    return {
      status: 'ok',
      providerId: provider.id,
      providerDisplayName: providerName || usage.providerName,
      providerName: usage.providerName || providerName,
      accountBrowser: usage.accountBrowser || '',
      websiteUrl,
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
    providerDisplayName: providerName,
    providerName,
    accountBrowser: '',
    websiteUrl,
    message: safeMessage(item?.message || 'Balance Hub 尚未返回额度', secrets),
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
    this.templateProbeTimeoutMs = Math.max(1_000, Number(options.templateProbeTimeoutMs) || DEFAULT_TEMPLATE_PROBE_TIMEOUT_MS);
    const configuredProbeDelay = Number(options.templateProbeSpeculationDelayMs);
    this.templateProbeSpeculationDelayMs = Number.isFinite(configuredProbeDelay)
      ? Math.max(0, configuredProbeDelay)
      : DEFAULT_TEMPLATE_PROBE_SPECULATION_DELAY_MS;
    this.now = options.now || Date.now;
    this.items = new Map();
    this.providers = new Map();
    this.refreshes = new Map();
    this.refreshAllPromise = null;
    this.refreshAllPendingIds = new Set();
    this.refreshAllPendingFull = false;
    this.refreshAllPendingFullStartedAt = null;
    this.refreshAllActiveIds = new Set();
    this.refreshAllActiveFull = false;
    this.cacheBatchDepth = 0;
    this.cacheDirty = false;
    this.cacheError = '';
    this.revision = 0;
    this.providerSnapshot = null;
    this.providerSelectors = new Map();
    this.publicProvidersCache = null;
    this.publicStateProvidersCache = null;
    this.publicStateRevision = -1;
    this.browserOriginsCache = null;
    this.lastFullRefreshAt = '';
    this.lastFullRefreshDurationMs = null;
    this.cachedItems = readCache(this.cachePath);
    try { this.syncProviders(); } catch {}
  }

  syncProviders() {
    const providers = this.repository.getAll();
    if (providers === this.providerSnapshot) return { changed: false, providers };
    this.requestUsageEngine?.clearStatusCache?.();
    const activeIds = new Set();
    for (const provider of providers) {
      const secrets = providerSecrets(provider);
      activeIds.add(provider.id);
      this.providers.set(provider.id, provider);
      const templateSelection = templateSelectionFor(provider, this.templateStore);
      const balanceTemplateOption = selectedTemplateOption(templateSelection, 'balance');
      const loginConfig = loginConfiguration(provider, balanceTemplateOption);
      const livePrevious = this.items.get(provider.id);
      const savedPrevious = livePrevious || (this.cachedItems[provider.id]
        ? cacheItem(this.cachedItems[provider.id], provider)
        : {});
      const providerFingerprint = providerConfigurationFingerprint(provider, templateSelection);
      const activeRefresh = this.refreshes.get(provider.id);
      if (activeRefresh && activeRefresh.fingerprint !== providerFingerprint) {
        activeRefresh.controller?.abort(new Error('供应商配置或模板已变更'));
      }
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
        name: sanitizedCredentialText(provider.name, secrets, 160),
        websiteUrl: safeWebsiteUrl(provider.websiteUrl, secrets),
        current: provider.isCurrent,
        status: configurationChanged || previous.status === 'loading' || obsoleteSource ? 'idle' : (staleBrowserFailure ? 'degraded' : (previous.status || 'idle')),
        message: configurationChanged
          ? '供应商配置已变更，等待重新查询'
          : obsoleteSource
          ? '等待 v3 独立余额中心重新查询'
          : restoredBrowserFailure
            ? (websiteLoginRequired
              ? '显示上次成功余额；请点击“去官网认证”，完成后手动刷新'
              : sessionSyncRequired
              ? '显示上次成功余额；请点击“同步现有会话”一次'
              : '显示上次成功余额；请手动重新登录后刷新')
            : String(previous.message || ''),
        source: configurationChanged ? '' : (obsoleteSource ? 'cached_previous' : String(previous.source || '')),
        loginSupported: Boolean(loginConfig),
        loginUrl: safeWebsiteUrl(loginConfig?.loginUrl, secrets),
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
        this.refreshes.get(id)?.controller?.abort(new Error('供应商已移除'));
        this.items.delete(id);
        this.providers.delete(id);
      }
    }
    this.cachedItems = {};
    this.providerSnapshot = providers;
    const selectors = new Map();
    for (const provider of providers) {
      const id = String(provider.id || '').trim().toLowerCase();
      if (id) selectors.set(id, provider);
    }
    for (const provider of providers) {
      for (const alias of providerAliases(provider)) {
        if (!selectors.has(alias)) selectors.set(alias, provider);
      }
    }
    this.providerSelectors = selectors;
    this.publicProvidersCache = null;
    this.browserOriginsCache = null;
    this.revision += 1;
    return { changed: true, providers };
  }

  getState() {
    if (this.publicStateRevision !== this.revision) {
      this.publicStateProvidersCache = [...this.items.values()]
        .map(item => this.#publicItem(item, this.refreshes.has(item.id)));
      this.publicStateRevision = this.revision;
    }
    return {
      version: 2,
      revision: this.revision,
      refreshing: this.refreshes.size > 0,
      lastFullRefreshAt: this.lastFullRefreshAt,
      lastFullRefreshDurationMs: this.lastFullRefreshDurationMs,
      cacheError: this.cacheError,
      providers: this.publicStateProvidersCache,
    };
  }

  getSummary() {
    return {
      providers: this.items.size,
      refreshing: this.refreshes.size > 0,
    };
  }

  findProvider(selector) {
    const key = String(selector || '').trim().toLowerCase();
    if (!key) return null;
    return this.providerSelectors.get(key) || null;
  }

  getProviderConfigurationFingerprint(providerOrSelector) {
    const provider = providerOrSelector && typeof providerOrSelector === 'object'
      ? providerOrSelector
      : this.findProvider(providerOrSelector);
    if (!provider) return '';
    return providerConfigurationFingerprint(provider, templateSelectionFor(provider, this.templateStore));
  }

  listPublicProviders() {
    if (this.publicProvidersCache) return this.publicProvidersCache;
    this.publicProvidersCache = [...this.providers.values()].map(provider => {
      const secrets = providerSecrets(provider);
      const templateSelection = templateSelectionFor(provider, this.templateStore);
      const balanceTemplateOption = selectedTemplateOption(templateSelection, 'balance');
      const loginConfig = loginConfiguration(provider, balanceTemplateOption);
      return {
        id: provider.id,
        name: sanitizedCredentialText(provider.name, secrets, 160),
        aliases: providerAliases(provider).filter(alias => !containsCredential(alias, secrets)),
        current: provider.isCurrent,
        loginSupported: Boolean(loginConfig),
        loginUrl: safeWebsiteUrl(loginConfig?.loginUrl, secrets),
        sessionSyncSupported: Boolean(loginConfig?.userHeader),
        accountBindingSupported: providerKind(provider) === 'anyrouter',
        templateSelection,
        queryMethod: safeQueryMethod(describeProviderQuery(provider, balanceTemplateOption), secrets),
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
    const preferredBalance = selection.balanceSource === 'builtin' && currentBalance?.autoDetect
      ? selection.balanceTemplateId === 'new-api-key-quota'
        ? ['packy-balance', selection.balanceTemplateId]
        : selection.balanceTemplateId === 'new-api-browser-account'
          ? ['packy-balance', 'new-api-key-quota', selection.balanceTemplateId]
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
    const currentRequestUsage = getRequestUsageTemplate(selection.requestUsageTemplateId);
    const requestCandidates = requestedRequestUsage
      ? [requestedRequestUsage]
      : currentRequestUsage?.selectable !== true
        ? [selection.requestUsageTemplateId]
        : ['new-api-token-log'];
    const controller = new AbortController();
    const timeoutError = new Error(`模板自动识别超过 ${Math.ceil(this.templateProbeTimeoutMs / 1_000)} 秒`);
    const timer = setTimeout(() => controller.abort(timeoutError), this.templateProbeTimeoutMs);
    const requestCache = { responses: new Map(), signal: controller.signal };
    try {
      const [balance, requestUsage] = await Promise.all([
        this.#probeBalanceCandidates(provider, selection, balanceCandidates, requestedBalance, {
          signal: controller.signal,
          requestCache,
        }),
        this.#probeRequestUsageCandidates(provider, selection, requestCandidates, requestedRequestUsage, {
          signal: controller.signal,
          requestCache,
        }),
      ]);
      return {
        success: Boolean(balance.recommendedTemplateId || balance.fallbackTemplateId || requestUsage.recommendedTemplateId),
        providerId: provider.id,
        testedAt: new Date(this.now()).toISOString(),
        balance,
        requestUsage,
      };
    } finally {
      if (!controller.signal.aborted) controller.abort(new Error('模板探测已完成'));
      clearTimeout(timer);
    }
  }

  listBrowserOrigins() {
    if (this.browserOriginsCache) return this.browserOriginsCache;
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
    this.browserOriginsCache = Object.freeze([...origins].sort());
    return this.browserOriginsCache;
  }

  refreshProvider(providerSelector) {
    const resolved = this.findProvider(providerSelector);
    if (!resolved) return Promise.reject(new Error('CCSwitch 中不存在这个 Codex 供应商'));
    const id = resolved.id;
    const activeRefresh = this.refreshes.get(id);
    const currentFingerprint = String(this.items.get(id)?.providerFingerprint || '');
    if (activeRefresh) {
      if (
        activeRefresh.provider === resolved
        && activeRefresh.fingerprint === currentFingerprint
        && sameAccountBinding(activeRefresh.accountBinding, this.items.get(id)?.accountBinding)
      ) {
        return activeRefresh.promise;
      }
      return activeRefresh.promise.catch(() => null).then(() => this.refreshProvider(id));
    }
    const provider = resolved;
    const previous = this.items.get(id);
    const refreshFingerprint = String(previous?.providerFingerprint || '');
    const queryStartedAt = this.now();
    this.items.set(id, { ...previous, status: previous.usage ? previous.status : 'loading', message: '' });
    this.revision += 1;
    const controller = new AbortController();
    const refresh = {
      provider,
      fingerprint: refreshFingerprint,
      accountBinding: previous.accountBinding || null,
      controller,
      promise: null,
    };
    const isCurrentSnapshot = () => this.providers.get(id) === provider
      && this.items.has(id)
      && String(this.items.get(id)?.providerFingerprint || '') === refreshFingerprint
      && sameAccountBinding(previous.accountBinding, this.items.get(id)?.accountBinding);
    const promise = Promise.resolve().then(async () => {
      const secrets = providerSecrets(provider);
      try {
        const anyRouterCredentials = providerKind(provider) === 'anyrouter'
          ? new Set([...this.providers.values()]
              .filter(candidate => providerKind(candidate) === 'anyrouter')
              .map(candidate => String(candidate.apiKey || candidate.id || '')))
          : null;
        const result = await this.queryEngine.query(provider, {
          signal: controller.signal,
          accountBinding: previous.accountBinding || null,
          allowSoleSessionFallback: !anyRouterCredentials || anyRouterCredentials.size <= 1,
          ...(selectedTemplateOption(previous.templateSelection, 'balance')
            ? { balanceTemplateId: selectedTemplateOption(previous.templateSelection, 'balance') }
            : {}),
        });
        if (!isCurrentSnapshot()) return this.items.get(id) || null;
        const attemptedAt = new Date(this.now()).toISOString();
        const usage = safeUsage(result.usage, secrets);
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
                ? safeMessage(result.message || 'API 可用性检查未通过，显示本地统计', secrets)
                : '')
              : safeMessage(result.message || '没有返回可显示的额度数据', secrets),
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
        const message = safeMessage(error, secrets);
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

  refreshAll(providerSelectors = null) {
    this.syncProviders();
    const fullRefresh = !Array.isArray(providerSelectors);
    const ids = Array.isArray(providerSelectors)
      ? [...new Set(providerSelectors
          .map(selector => this.findProvider(selector)?.id || '')
          .filter(Boolean))]
      : [...this.providers.keys()];
    const uncoveredIds = ids.filter(id => !this.refreshAllActiveIds.has(id));
    for (const id of uncoveredIds) this.refreshAllPendingIds.add(id);
    if (fullRefresh && (!this.refreshAllActiveFull || uncoveredIds.length > 0)) {
      this.refreshAllPendingFull = true;
      this.refreshAllPendingFullStartedAt ??= this.now();
    }
    return this.#startRefreshAllDrain();
  }

  #startRefreshAllDrain() {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.refreshAllPromise = (async () => {
      this.cacheBatchDepth += 1;
      try {
        while (this.refreshAllPendingFull || this.refreshAllPendingIds.size > 0) {
          const batchStartedAt = this.now();
          const batchIsFull = this.refreshAllPendingFull;
          const fullRefreshStartedAt = batchIsFull
            ? (this.refreshAllPendingFullStartedAt ?? batchStartedAt)
            : null;
          const batchIds = [...this.refreshAllPendingIds];
          this.refreshAllPendingFull = false;
          this.refreshAllPendingFullStartedAt = null;
          this.refreshAllPendingIds.clear();
          this.refreshAllActiveFull = batchIsFull;
          this.refreshAllActiveIds = new Set(batchIds);
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
          const browserIds = batchIds.filter(id => {
            const method = this.items.get(id)?.queryMethod;
            return method?.requiresBrowser === true || method?.type === 'api-key-with-account-fallback';
          });
          const browserIdSet = new Set(browserIds);
          const directIds = batchIds.filter(id => !browserIdSet.has(id));
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
            await runPool(batchIds, this.concurrency);
          }
          if (batchIsFull) {
            this.lastFullRefreshAt = new Date(this.now()).toISOString();
            this.lastFullRefreshDurationMs = Math.max(0, this.now() - fullRefreshStartedAt);
          }
          this.refreshAllActiveFull = false;
          this.refreshAllActiveIds.clear();
          this.revision += 1;
        }
        return this.getState();
      } finally {
        this.refreshAllActiveFull = false;
        this.refreshAllActiveIds.clear();
        this.cacheBatchDepth = Math.max(0, this.cacheBatchDepth - 1);
        if (this.cacheDirty) this.#writeCache();
      }
    })().finally(() => {
      this.refreshAllPromise = null;
      if (this.refreshAllPendingFull || this.refreshAllPendingIds.size > 0) {
        return this.#startRefreshAllDrain();
      }
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
    throwIfAborted(options.signal);
    const provider = this.findProvider(providerSelector);
    if (!provider) {
      return {
        success: false,
        notFound: true,
        message: `Unknown provider: ${String(providerSelector || '')}`,
      };
    }
    const requestProvider = canonicalAnyRouterRequestProvider(provider, this.providers.values());
    const limit = normalizeRequestUsageLimit(options.limit);
    const templateSelection = this.items.get(requestProvider.id)?.templateSelection
      || templateSelectionFor(requestProvider, this.templateStore);
    const requestUsageTemplateOption = selectedTemplateOption(templateSelection, 'requestUsage');
    let credentialAppTypes = ['codex'];
    try {
      if (typeof this.repository?.getCredentialAppTypes === 'function') {
        credentialAppTypes = this.repository.getCredentialAppTypes(requestProvider.apiKey);
      }
    } catch {}
    const sharedAcrossApps = credentialAppTypes.some(appType => appType !== 'codex');
    const getLocalRequestRows = createLocalRequestRowsReader(this.repository, requestProvider.id, limit);
    const accountBinding = this.items.get(requestProvider.id)?.accountBinding || null;
    const secrets = [...new Set([...providerSecrets(provider), ...providerSecrets(requestProvider)])];
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
        remoteResult = await this.requestUsageEngine.query(requestProvider, {
          ...options,
          limit,
          appType: 'codex',
          strictAppType: sharedAcrossApps,
          ...(getLocalRequestRows ? { getLocalRequestRows } : {}),
          ...(accountBinding ? { accountBinding } : {}),
          ...(requestUsageTemplateOption ? { requestUsageTemplateId: requestUsageTemplateOption } : {}),
        });
        throwIfAborted(options.signal);
        if (requestProvider.id !== provider.id) {
          remoteResult = {
            ...remoteResult,
            providerId: provider.id,
            providerName: provider.name,
          };
        }
      } catch (error) {
        throwIfAborted(options.signal);
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
          message: safeMessage(error, secrets),
        };
      }
    }
    if (remoteResult?.success === true) {
      return {
        ...remoteResult,
        message: remoteResult.message ? safeMessage(remoteResult.message, secrets) : '',
        appType: 'codex',
        credentialSharedAcrossApps: sharedAcrossApps,
        fallback: false,
        preciseCostAvailable: remoteResult?.billing?.exact === true,
      };
    }
    remoteResult = {
      ...remoteResult,
      message: remoteResult?.message ? safeMessage(remoteResult.message, secrets) : '',
    };
    throwIfAborted(options.signal);
    if (typeof this.repository?.getRecentRequests !== 'function') return remoteResult;
    try {
      const rows = getLocalRequestRows ? getLocalRequestRows(limit) : this.repository.getRecentRequests(provider.id, limit);
      if (!Array.isArray(rows)) return remoteResult;
      const fallback = ccswitchRequestUsageFallback(provider, rows, remoteResult, limit, this.now);
      return { ...fallback, fallbackReason: safeMessage(fallback.fallbackReason, secrets), message: safeMessage(fallback.message, secrets) };
    } catch (error) {
      return {
        ...remoteResult,
        fallback: false,
        fallbackError: safeMessage(error, secrets),
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
    const id = provider.id;
    const fingerprint = this.getProviderConfigurationFingerprint(provider);
    const result = await this.queryEngine.bindBrowserAccount(provider, { clientRef: String(options.clientRef || '').trim() });
    this.syncProviders();
    const currentProvider = this.providers.get(id);
    if (
      currentProvider !== provider
      || !this.items.has(id)
      || this.getProviderConfigurationFingerprint(currentProvider) !== fingerprint
    ) throw new Error('供应商在账号绑定期间已变更');
    if (result?.failure) {
      return {
        ...this.#publicItem(this.items.get(provider.id)),
        bindingAttemptFailed: true,
        message: safeMessage(result.failure.message || 'AnyRouter 账号绑定失败', providerSecrets(provider)),
      };
    }
    const binding = safeAccountBinding(result?.binding);
    if (!binding) throw new Error('AnyRouter 账号绑定结果无效');
    const previousItems = new Map(this.items);
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
    if (!this.#writeCache(true)) {
      this.items = previousItems;
      this.revision += 1;
      throw new Error(`AnyRouter 账号绑定未能保存：${this.cacheError || 'Hub 缓存不可写'}`);
    }
    await this.refreshProvider(provider.id);
    return this.#publicItem(this.items.get(provider.id));
  }

  clearAccountBinding(providerSelector) {
    const provider = this.findProvider(providerSelector);
    if (!provider) throw new Error('CCSwitch 中不存在这个 Codex 供应商');
    if (providerKind(provider) !== 'anyrouter') throw new Error('只有 AnyRouter 支持显式浏览器账号绑定');
    const selected = this.items.get(provider.id);
    const previousItems = new Map(this.items);
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
    if (!this.#writeCache(true)) {
      this.items = previousItems;
      this.revision += 1;
      throw new Error(`AnyRouter 账号解绑未能保存：${this.cacheError || 'Hub 缓存不可写'}`);
    }
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
        ? `已在${action?.browser ? ` ${action.browser} 浏览器` : '现有浏览器'}中打开登录页；登录完成后回到 Hub 将自动检查一次`
        : '未能同步现有浏览器会话，请先在官网确认登录状态'), providerSecrets(provider)),
    });
    this.revision += 1;
    return this.#publicItem(this.items.get(id));
  }

  #resyncTemplateProvider(provider) {
    this.providerSnapshot = null;
    this.publicProvidersCache = null;
    this.requestUsageEngine?.clearStatusCache?.();
    this.syncProviders();
    this.#writeCache();
    return this.#publicItem(this.items.get(provider.id));
  }

  async #probeBalanceCandidates(provider, selection, candidates, requestedTemplateId, options = {}) {
    const results = [];
    let recommendedTemplateId = '';
    let fallbackTemplateId = '';
    const matchesTemplate = result => result?.status === 'success' || result?.schemaValidated === true;
    if (candidates.length) {
      const candidateController = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, candidateController.signal])
        : candidateController.signal;
      const run = templateId => this.#probeBalanceTemplate(provider, templateId, {
        useBuiltin: selection.balanceSource === 'builtin' && selection.balanceTemplateId === templateId,
        signal,
        requestCache: options.requestCache,
      });
      const first = run(candidates[0]);
      let remaining = null;
      const startRemaining = () => {
        if (!remaining) remaining = candidates.slice(1).map(run);
        return remaining;
      };
      let speculationTimer = null;
      if (candidates.length > 1 && this.templateProbeSpeculationDelayMs > 0) {
        speculationTimer = setTimeout(startRemaining, this.templateProbeSpeculationDelayMs);
      } else if (candidates.length > 1) {
        startRemaining();
      }
      const firstResult = await first;
      if (speculationTimer) clearTimeout(speculationTimer);
      results.push(firstResult);
      if (matchesTemplate(firstResult)) {
        recommendedTemplateId = candidates[0];
      } else if (!options.signal?.aborted) {
        const pending = startRemaining();
        for (let index = 0; index < pending.length; index += 1) {
          const result = await pending[index];
          results.push(result);
          if (matchesTemplate(result)) {
            recommendedTemplateId = candidates[index + 1];
            break;
          }
        }
      }
      if (recommendedTemplateId) candidateController.abort(new Error('已识别到更高优先级的余额模板'));
      if (remaining) await Promise.allSettled(remaining);
    }
    if (!requestedTemplateId && !recommendedTemplateId && !options.signal?.aborted) {
      const fallback = await this.#probeBalanceTemplate(provider, 'api-health-local', options);
      results.push(fallback);
      if (fallback.status === 'success') fallbackTemplateId = 'api-health-local';
    }
    return { recommendedTemplateId, fallbackTemplateId, results };
  }

  async #probeRequestUsageCandidates(provider, selection, candidates, requestedTemplateId, options = {}) {
    const results = [];
    let recommendedTemplateId = '';
    for (const templateId of candidates) {
      const result = await this.#probeRequestUsageTemplate(provider, templateId, {
        ...options,
        useBuiltin: selection.requestUsageSource === 'builtin'
          && selection.requestUsageTemplateId === templateId,
      });
      results.push(result);
      if (result.status === 'success') {
        recommendedTemplateId = templateId;
        break;
      }
    }
    if (!requestedTemplateId && !recommendedTemplateId && !options.signal?.aborted) {
      const fallback = await this.#probeRequestUsageTemplate(provider, 'ccswitch-local', options);
      results.push(fallback);
      if (fallback.status === 'success') recommendedTemplateId = 'ccswitch-local';
    }
    return { recommendedTemplateId, results };
  }

  async #probeBalanceTemplate(provider, templateId, options = {}) {
    const secrets = providerSecrets(provider);
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
      const result = await abortableOperation(this.queryEngine.query(provider, {
        ...(options.useBuiltin === true ? {} : { balanceTemplateId: templateId }),
        bypassCache: true,
        timeoutMs: 8_000,
        signal: options.signal,
        requestCache: options.requestCache,
        accountBinding: this.items.get(provider.id)?.accountBinding || null,
      }), options.signal);
      const source = String(result?.source || '');
      const localFallback = result?.degraded === true
        || source === 'muyuan_local_usage'
        || source === 'api_health_and_local_usage';
      const usage = safeProbeUsage(result?.usage, source, secrets);
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
        message: safeMessage(result?.message || (localFallback ? '只取得本地回退数据，未验证远端额度结构' : '没有返回可验证的额度数据'), secrets),
        ...(result?.schemaValidated === true ? { schemaValidated: true } : {}),
      };
    } catch (error) {
      return { ...base, message: safeMessage(error, secrets) };
    }
  }

  async #probeRequestUsageTemplate(provider, templateId, options = {}) {
    const secrets = providerSecrets(provider);
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
        return { ...base, message: safeMessage(error, secrets) };
      }
    }
    if (!this.requestUsageEngine?.query) return { ...base, message: '第三方逐请求查询引擎未启用' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('逐请求模板测试超过 8 秒')), 8_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const getLocalRequestRows = createLocalRequestRowsReader(this.repository, provider.id, 10);
      const result = await abortableOperation(this.requestUsageEngine.query(provider, {
        ...(options.useBuiltin === true ? {} : { requestUsageTemplateId: templateId }),
        bypassCache: true,
        limit: 10,
        appType: 'codex',
        signal,
        requestCache: options.requestCache,
        ...(getLocalRequestRows ? { getLocalRequestRows } : {}),
        accountBinding: this.items.get(provider.id)?.accountBinding || null,
      }), signal);
      if (result?.success === true) {
        return {
          ...base,
          status: 'success',
          message: result?.degraded ? safeMessage(result.message || '调用成功，但计费配置不完整', secrets) : '调用成功',
          preview: {
            requestCount: Math.max(0, Number(result.requestCount) || 0),
            source: String(result.source || '').slice(0, 80),
            costUnit: String(result.billing?.unit || '').slice(0, 24),
            costExact: result.billing?.exact === true,
          },
        };
      }
      return { ...base, message: safeMessage(result?.message || '没有返回可验证的逐请求日志', secrets) };
    } catch (error) {
      return { ...base, message: safeMessage(error, secrets) };
    } finally {
      clearTimeout(timer);
    }
  }

  #publicItem(item, refreshing = false) {
    if (!item) return null;
    const secrets = providerSecrets(this.providers.get(item.id));
    const {
      providerFingerprint: _providerFingerprint,
      accountBinding: internalAccountBinding,
      ...publicItem
    } = item;
    return {
      ...publicItem,
      name: sanitizedCredentialText(publicItem.name, secrets, 160),
      message: safeMessage(publicItem.message || '', secrets),
      source: sanitizedCredentialText(publicItem.source, secrets, 160),
      websiteUrl: safeWebsiteUrl(publicItem.websiteUrl, secrets),
      loginUrl: safeWebsiteUrl(publicItem.loginUrl, secrets),
      queryMethod: safeQueryMethod(publicItem.queryMethod, secrets),
      usage: publicItem.usage ? safeUsage({ status: 'ok', ...publicItem.usage }, secrets) : null,
      accountBinding: publicAccountBinding(internalAccountBinding),
      refreshing,
    };
  }

  #balanceResponse(item) {
    if (!item) {
      return { success: false, provider: '', message: '供应商缓存不存在', login_required: false };
    }
    const publicItem = this.#publicItem(item, this.refreshes.has(item.id));
    const queryable = ['ok', 'degraded'].includes(publicItem.status) && publicItem.usage;
    if (!queryable) {
      return {
        success: false,
        provider: publicItem.id,
        message: publicItem.message || '余额查询失败',
        login_required: publicItem.status === 'login-required',
      };
    }
    return {
      success: true,
      provider: publicItem.id,
      data: {
        isValid: true,
        planName: publicItem.usage.providerName || publicItem.name,
        remaining: publicItem.usage.remaining,
        used: publicItem.usage.used,
        total: publicItem.usage.total,
        unit: publicItem.usage.unit,
        extra: publicItem.usage.extra,
        periodLabel: publicItem.usage.periodLabel,
        hideTotal: publicItem.usage.hideTotal,
        updatedAt: publicItem.usage.updatedAt,
        source: publicItem.source,
      },
    };
  }

  #writeCache(force = false) {
    if (!this.cachePath) return true;
    if (this.cacheBatchDepth > 0 && !force) {
      this.cacheDirty = true;
      return true;
    }
    try {
      const providers = [];
      let serializedBytes = Buffer.byteLength('{"version":3,"providers":[]}');
      for (const item of [...this.items.values()].slice(0, MAX_HUB_CACHE_PROVIDERS)) {
        const safeItem = cacheItem(item, this.providers.get(item.id));
        const itemBytes = Buffer.byteLength(JSON.stringify(safeItem)) + (providers.length ? 1 : 0);
        if (serializedBytes + itemBytes > MAX_HUB_CACHE_BYTES) break;
        providers.push(safeItem);
        serializedBytes += itemBytes;
      }
      secureAtomicWriteFileSync(this.cachePath, JSON.stringify({ version: 3, providers }), { encoding: 'utf8' });
      this.cacheDirty = false;
      this.cacheError = '';
      return true;
    } catch (error) {
      this.cacheDirty = true;
      this.cacheError = safeMessage(error);
      return false;
    }
  }
}

export { safeMessage as safeHubMessage, safeUsage as sanitizeHubUsage };
