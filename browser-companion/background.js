import {
  browserJobTimeout,
  browserResponseMetadata,
  companionPollFailurePolicy,
  browserSessionOutcome,
  browserSessionUserId,
  MAX_BROWSER_RESPONSE_BYTES,
  normalizeSessionOrigins,
  readLimitedResponseText,
  selectReadySessionTab,
  SESSION_ORIGINS,
  SessionHintStore,
  SessionIdentityStore,
  TrailingSingleFlight,
} from './session-state.js';
import {
  isAnyRouterAcwUrl,
  withAnyRouterAcwRetry,
} from './anyrouter-waf.js';
import {
  assertHostJobCompatibility,
  BROWSER_FETCH_ATTEMPT_TIMEOUT_MS,
  BROWSER_RESULT_DELIVERY_RESERVE_MS,
  companionHandshake,
} from './protocol.js';
import { buildCompanionAuth, verifyCompanionResponse } from './auth.js';

const HUB_ORIGIN = 'http://127.0.0.1:17891';
const COMPANION_API_PREFIX = '/companion/v3';
const POLL_ALARM = 'ccswitch-balance-companion-poll';
const HEARTBEAT_DEBOUNCE_MS = 350;
const HUB_REQUEST_TIMEOUT_MS = 10_000;
const HUB_POLL_TIMEOUT_MS = 30_000;
const POLL_BATCH_SIZE = 120;
const MAX_COMPANION_RESULT_REQUEST_BYTES = 2_000_000;
const PROVIDER_ORIGINS_KEY = 'providerWebsiteOrigins';
const PENDING_ORIGINS_KEY = 'pendingWebsiteOrigins';
const CONFIG_STORAGE_KEYS = [
  'companionToken', 'hubToken', 'pairingUpgradeRequired', 'clientId', 'clientBrowser', 'lastError',
];
const CONFIG_INVALIDATION_KEYS = new Set([
  'companionToken', 'hubToken', 'pairingUpgradeRequired', 'clientId', 'clientBrowser',
]);
const WATCHED_ORIGIN_KEYS = new Set(['validatedSessionOrigins', PROVIDER_ORIGINS_KEY]);
const manifest = chrome.runtime.getManifest();
const sessionHints = new SessionHintStore(chrome.storage.local);
const sessionIdentities = new SessionIdentityStore(chrome.storage.local);
const providerWebsiteOrigins = new SessionHintStore(chrome.storage.local, PROVIDER_ORIGINS_KEY);
const pendingWebsiteOrigins = new SessionHintStore(chrome.storage.local, PENDING_ORIGINS_KEY);
const instanceId = crypto.randomUUID();
let polling = false;
let lastErrorValue;
let statusUpdateChain = Promise.resolve();
let configCache = null;
let configPromise = null;
let configGeneration = 0;
let watchedOriginsCache = null;
let watchedOriginsPromise = null;
let watchedOriginsGeneration = 0;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function withTimeout(operation, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function browserName() {
  const value = navigator.userAgent;
  if (/Edg\//.test(value)) return 'Edge';
  if (/Chrome\//.test(value)) return 'Chrome';
  return 'Chromium';
}

async function config() {
  if (configCache) return configCache;
  if (configPromise) return configPromise;
  const generation = configGeneration;
  const operation = (async () => {
    const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEYS);
    const legacyPairingRequired = !stored.companionToken
      && Boolean(stored.hubToken || stored.pairingUpgradeRequired);
    if (stored.hubToken && !stored.companionToken) {
      await chrome.storage.local.set({ pairingUpgradeRequired: true });
    }
    const obsoleteKeys = [];
    if (stored.hubToken) obsoleteKeys.push('hubToken');
    if (stored.companionToken && stored.pairingUpgradeRequired) obsoleteKeys.push('pairingUpgradeRequired');
    if (obsoleteKeys.length) await chrome.storage.local.remove(obsoleteKeys);
    const currentBrowser = browserName();
    let clientId = stored.clientId;
    if (
      !/^[A-Za-z0-9_-]{8,128}$/.test(String(clientId || ''))
      || String(stored.clientBrowser || '') !== currentBrowser
    ) {
      clientId = crypto.randomUUID();
      await chrome.storage.local.set({ clientId, clientBrowser: currentBrowser });
    }
    lastErrorValue = String(stored.lastError || '');
    const resolved = {
      token: String(stored.companionToken || '').trim(),
      legacyPairingRequired,
      clientId,
      browser: currentBrowser,
      lastError: lastErrorValue,
    };
    if (generation === configGeneration) configCache = resolved;
    return resolved;
  })();
  configPromise = operation;
  try {
    return await operation;
  } finally {
    if (configPromise === operation) configPromise = null;
  }
}

function updateStatus({ lastHeartbeatAt, lastError } = {}) {
  const hasLastError = lastError !== undefined;
  const nextLastError = hasLastError ? String(lastError || '') : '';
  statusUpdateChain = statusUpdateChain.catch(() => {}).then(async () => {
    if (lastErrorValue === undefined) {
      const stored = await chrome.storage.local.get(['lastError']);
      lastErrorValue = String(stored.lastError || '');
    }
    const update = {};
    if (lastHeartbeatAt) update.lastHeartbeatAt = lastHeartbeatAt;
    if (hasLastError && nextLastError !== lastErrorValue) update.lastError = nextLastError;
    if (!Object.keys(update).length) return false;
    await chrome.storage.local.set(update);
    if (Object.hasOwn(update, 'lastError')) {
      lastErrorValue = nextLastError;
      if (configCache) configCache = { ...configCache, lastError: nextLastError };
    }
    return true;
  });
  return statusUpdateChain;
}

function rememberPendingWebsiteOrigin(origin) {
  return pendingWebsiteOrigins.remember(origin);
}

async function watchedSessionOrigins() {
  if (watchedOriginsCache) return watchedOriginsCache;
  if (watchedOriginsPromise) return watchedOriginsPromise;
  const generation = watchedOriginsGeneration;
  const operation = Promise.all([
    sessionHints.list(),
    providerWebsiteOrigins.list(),
  ]).then(([hints, providerOrigins]) => {
    const origins = normalizeSessionOrigins([
      ...SESSION_ORIGINS,
      ...hints,
      ...providerOrigins,
    ]);
    if (generation === watchedOriginsGeneration) watchedOriginsCache = origins;
    return origins;
  });
  watchedOriginsPromise = operation;
  try {
    return await operation;
  } finally {
    if (watchedOriginsPromise === operation) watchedOriginsPromise = null;
  }
}

function invalidateWatchedOrigins() {
  watchedOriginsGeneration += 1;
  watchedOriginsCache = null;
  watchedOriginsPromise = null;
}

async function requestHub(token, path, options = {}, timeoutMs = HUB_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = String(options.method || 'GET').toUpperCase();
    const body = String(options.body || '');
    const target = `${COMPANION_API_PREFIX}${path}`;
    const authentication = await buildCompanionAuth(token, { method, target, body });
    const response = await fetch(`${HUB_ORIGIN}${target}`, {
      ...options,
      method,
      redirect: 'error',
      headers: { ...(options.headers || {}), ...authentication.headers },
      signal: controller.signal,
    });
    const text = response.status === 204
      ? ''
      : await readLimitedResponseText(response, MAX_BROWSER_RESPONSE_BYTES, 'Balance Hub 响应过大');
    await verifyCompanionResponse(token, {
      requestNonce: authentication.nonce,
      status: response.status,
      body: text,
      headers: response.headers,
    });
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch { throw new Error('Balance Hub 返回了无效 JSON'); }
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function cookieSessions() {
  const sessions = [];
  for (const origin of ['https://chatgpt.com']) {
    try {
      const cookies = await chrome.cookies.getAll({ url: origin });
      if (cookies.some(cookie => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000)) sessions.push(origin);
    } catch {}
  }
  return sessions;
}

async function knownSessions() {
  const [persisted, cookies] = await Promise.all([
    sessionHints.list(),
    cookieSessions(),
  ]);
  return normalizeSessionOrigins([...persisted, ...cookies]);
}

async function post(token, path, body) {
  const { response, payload } = await requestHub(token, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(String(payload?.message || `Balance Hub callback returned HTTP ${response.status}`));
  return payload;
}

async function performHeartbeat(current) {
  const resolved = current || await config();
  if (!resolved.token) return { connected: false, configured: false };
  const payload = {
    clientId: resolved.clientId,
    instanceId,
    browser: resolved.browser,
    version: manifest.version,
    ...companionHandshake(),
    sessions: await knownSessions(),
  };
  const result = await post(resolved.token, '/heartbeat', payload);
  const providerOrigins = Array.isArray(result?.providerOrigins)
    ? await providerWebsiteOrigins.replace(result.providerOrigins)
    : await providerWebsiteOrigins.list();
  await updateStatus({ lastHeartbeatAt: new Date().toISOString(), lastError: '' });
  return { connected: true, configured: true, companion: result.companion, providerOrigins };
}

const heartbeatControl = new TrailingSingleFlight(performHeartbeat, HEARTBEAT_DEBOUNCE_MS);

function heartbeat(current) {
  return heartbeatControl.runNow(current);
}

function scheduleHeartbeat() {
  heartbeatControl.schedule();
}

async function matchingTabs(origin) {
  try { return await chrome.tabs.query({ url: `${origin}/*` }); } catch { return []; }
}

function interactiveResponseText(metadata) {
  return metadata.cfMitigated
    ? 'Cloudflare challenge response'
    : 'Interactive website page returned instead of JSON';
}

function browserAttemptTime(deadline) {
  return Math.min(
    BROWSER_FETCH_ATTEMPT_TIMEOUT_MS,
    remainingJobTime(deadline, BROWSER_RESULT_DELIVERY_RESERVE_MS),
  );
}

const WEBSITE_PERMISSION_MESSAGE = '余额伴侣缺少供应商网站查询权限；请打开扩展弹窗并点击“授予网站查询权限”';

async function hasWebsitePermission(origin) {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

function websitePermissionFailure(origin) {
  return {
    status: 0,
    url: origin,
    text: '',
    permissionRequired: true,
    error: WEBSITE_PERMISSION_MESSAGE,
  };
}

async function fetchInsideTab(tabId, request, timeoutMs) {
  const targetUrl = new URL(request.requestPath || '/', request.baseUrl).href;
  let results;
  try {
    results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        // Keep the request in the extension world. The companion's host
        // permissions and credentials policy are the stable path for ordinary
        // API calls; the existing tab is only a bounded fallback for WAF pages.
        world: 'ISOLATED',
        args: [{ targetUrl, headers: request.headers || {}, userHeader: request.userHeader || '', timeoutMs, maximumBytes: MAX_BROWSER_RESPONSE_BYTES }],
        func: async settings => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      let identityFound = false;
      const readText = async response => {
        const contentLengthHeader = response.headers?.get?.('content-length');
        const contentLength = contentLengthHeader == null || String(contentLengthHeader).trim() === ''
          ? null
          : Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > settings.maximumBytes) throw new Error('第三方网站响应过大');
        if (!response.body || typeof response.body.getReader !== 'function') {
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > settings.maximumBytes) throw new Error('第三方网站响应过大');
          return text;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let receivedBytes = 0;
        let cancelled = false;
        const cancel = reason => {
          if (cancelled) return;
          cancelled = true;
          try { reader.cancel(reason)?.catch?.(() => {}); } catch {}
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            receivedBytes += bytes.byteLength;
            if (receivedBytes > settings.maximumBytes) {
              const error = new Error('第三方网站响应过大');
              cancel(error);
              throw error;
            }
            text += decoder.decode(bytes, { stream: true });
            const trimmedText = text.trim();
            if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
              try {
                JSON.parse(trimmedText);
                cancel('response complete');
                return text;
              } catch {}
            }
          }
          text += decoder.decode();
          return text;
        } catch (error) {
          cancel(error);
          throw error;
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      };
      try {
        const outgoing = { Accept: 'application/json', ...settings.headers };
        if (settings.userHeader && !outgoing[settings.userHeader]) {
          let user = {};
          try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
          if (user.id != null) {
            outgoing[settings.userHeader] = String(user.id);
            identityFound = true;
          }
        }
        const response = await fetch(settings.targetUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          headers: outgoing,
          signal: controller.signal,
        });
        const contentType = String(response.headers?.get?.('content-type') || '').trim().toLowerCase();
        const cfMitigatedValue = String(response.headers?.get?.('cf-mitigated') || '').trim().toLowerCase();
        const isJson = /(?:^|\/)json(?:;|$)/.test(contentType) || /\+json(?:;|$)/.test(contentType);
        const cfMitigated = cfMitigatedValue.includes('challenge');
        const interactivePage = !isJson && (
          cfMitigated
          || /(?:text\/html|application\/xhtml\+xml)/.test(contentType)
          || (response.status === 403 && !contentType)
        );
        return {
          status: response.status,
          url: response.url,
          text: interactivePage
            ? (cfMitigated ? 'Cloudflare challenge response' : 'Interactive website page returned instead of JSON')
            : await readText(response),
          identityFound,
          contentType,
          cfMitigated,
          interactivePage,
        };
      } catch (error) {
        return { status: 0, url: location.href, text: '', identityFound, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
        },
      }),
      timeoutMs,
      '网页查询超时',
    );
  } catch (error) {
    return {
      status: 0,
      url: targetUrl,
      text: '',
      identityFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return results?.[0]?.result || { status: 0, text: '', error: '网页脚本没有返回结果' };
}

function isJsonText(value) {
  try { JSON.parse(String(value || '').trim()); return true; } catch { return false; }
}

async function fetchFromExtension(request, userId, timeoutMs) {
  const targetUrl = new URL(request.requestPath || '/', request.baseUrl).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchOnce = async () => {
    const outgoing = { Accept: 'application/json', ...(request.headers || {}) };
    if (request.userHeader && userId) outgoing[request.userHeader] = userId;
    const response = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: outgoing,
      signal: controller.signal,
    });
    const metadata = browserResponseMetadata(
      response.status,
      response.headers?.get?.('content-type'),
      response.headers?.get?.('cf-mitigated'),
    );
    const preserveAnyRouterChallenge = isAnyRouterAcwUrl(targetUrl)
      && metadata.interactivePage
      && !metadata.cfMitigated;
    return {
      status: response.status,
      url: response.url,
      text: metadata.interactivePage && !preserveAnyRouterChallenge
        ? interactiveResponseText(metadata)
        : await readLimitedResponseText(response),
      ...metadata,
    };
  };
  try {
    if (!isAnyRouterAcwUrl(targetUrl)) return await fetchOnce();
    return await withAnyRouterAcwRetry(fetchOnce, async value => {
      await chrome.cookies.set({
        url: new URL('/', targetUrl).href,
        name: 'acw_sc__v2',
        value,
        path: '/',
        secure: true,
      });
    });
  } catch (error) {
    return { status: 0, url: targetUrl, text: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function syncNewApiSession(request, deadline) {
  const origin = new URL(request.baseUrl).origin;
  if (!await hasWebsitePermission(origin)) {
    await rememberPendingWebsiteOrigin(origin);
    return {
      synced: false,
      opened: false,
      loginRequired: false,
      permissionRequired: true,
      message: WEBSITE_PERMISSION_MESSAGE,
    };
  }
  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  const preferred = selectReadySessionTab(tabs);
  if (!preferred) return focusLoginPage(request);
  const result = await fetchInsideTab(preferred.id, request, browserAttemptTime(deadline));
  const userId = browserSessionUserId(request, result);
  if (!userId) {
    const opened = await focusLoginPage(request);
    const outcome = browserSessionOutcome(request, result);
    return {
      ...opened,
      loginRequired: outcome === 'invalid',
      verificationRequired: result.interactivePage === true,
      message: result.interactivePage === true
        ? '官网正在要求 Cloudflare/WAF 验证，已打开官网；完成验证后请手动刷新'
        : outcome === 'invalid'
          ? '现有浏览器登录已失效，已打开官网；完成认证后请手动刷新'
          : String(result.error || '未能同步网站用户身份，已打开官网；完成认证后请手动刷新'),
    };
  }
  await sessionIdentities.remember(origin, userId);
  await sessionHints.remember(origin);
  scheduleHeartbeat();
  return { synced: true, opened: false, origin };
}

async function focusLoginPage(request) {
  const loginUrl = String(request.loginUrl || request.baseUrl || '');
  if (!loginUrl.startsWith('https://')) throw new Error('登录地址无效');
  const origin = new URL(loginUrl).origin;
  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { url: loginUrl, active: true });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: loginUrl, active: true });
  }
  return { opened: true, origin };
}

async function queryThroughCurrentBrowser(request, deadline) {
  const origin = new URL(request.baseUrl).origin;
  if (!await hasWebsitePermission(origin)) {
    await rememberPendingWebsiteOrigin(origin);
    return websitePermissionFailure(origin);
  }
  const userId = await sessionIdentities.get(origin);
  const direct = await fetchFromExtension(request, userId, browserAttemptTime(deadline));
  const directOutcome = browserSessionOutcome(request, direct);
  if (isJsonText(direct.text) && (!request.userHeader || directOutcome === 'valid')) return direct;

  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  const preferred = selectReadySessionTab(tabs);
  if (preferred) {
    const pageResult = await fetchInsideTab(preferred.id, request, browserAttemptTime(deadline));
    const pageOutcome = browserSessionOutcome(request, pageResult);
    if (isJsonText(pageResult.text) && (!request.userHeader || pageOutcome === 'valid')) return pageResult;
    const targetUrl = new URL(request.requestPath || '/', request.baseUrl).href;
    const needsAnyRouterSolver = pageResult.interactivePage === true && isAnyRouterAcwUrl(targetUrl);
    if (Number(pageResult.status) > 0 && !needsAnyRouterSolver) return pageResult;
  }

  return request.userHeader && !userId ? { ...direct, identityMissing: true } : direct;
}

function remainingJobTime(deadline, reserveMs = 0) {
  return Math.max(1_000, deadline - Date.now() - reserveMs);
}

async function openLogin(request, deadline) {
  if (request.userHeader) return syncNewApiSession(request, deadline);
  return focusLoginPage(request);
}

async function executeJob(job, deadline) {
  if (job.type === 'open-login') return openLogin(job.request, deadline);
  if (job.type === 'query-json') return queryThroughCurrentBrowser(job.request, deadline);
  throw new Error(`不支持的浏览器任务: ${job.type}`);
}

async function pollOnce(current) {
  if (!current.token) return false;
  const handshake = companionHandshake();
  const query = new URLSearchParams({
    clientId: current.clientId,
    instanceId,
    browser: current.browser,
    version: manifest.version,
    protocolVersion: String(handshake.protocolVersion),
  });
  for (const capability of handshake.capabilities) query.append('capability', capability);
  const { response, payload } = await requestHub(
    current.token,
    `/job?${query}`,
    { cache: 'no-store' },
    HUB_POLL_TIMEOUT_MS,
  );
  if (response.status === 204) return true;
  if (!response.ok) throw new Error(String(payload?.message || `Balance Hub job poll returned HTTP ${response.status}`));
  const job = payload.job;
  assertHostJobCompatibility(job);
  const timeoutMs = browserJobTimeout(job);
  const startedAt = Date.now();
  const hostExpiresAt = Date.parse(String(job.expiresAt || ''));
  const localDeadline = startedAt + timeoutMs;
  const deadline = Number.isFinite(hostExpiresAt)
    ? Math.min(localDeadline, hostExpiresAt - BROWSER_RESULT_DELIVERY_RESERVE_MS)
    : localDeadline;
  const executionTimeoutMs = deadline - startedAt;
  const claim = {
    clientId: current.clientId,
    instanceId,
    browser: current.browser,
    claimToken: job.claimToken,
  };
  let value;
  let outcome = null;
  try {
    if (executionTimeoutMs < 1_000) throw new Error('浏览器任务已超过宿主截止时间');
    value = await withTimeout(executeJob(job, deadline), executionTimeoutMs + 500, '第三方网站余额查询超时');
    outcome = job.type === 'query-json' ? browserSessionOutcome(job.request, value) : null;
    const userId = job.type === 'query-json' ? browserSessionUserId(job.request, value) : '';
    const sessionOrigin = job.request.origin || job.request.baseUrl;
    if (outcome === 'valid') {
      await sessionHints.remember(sessionOrigin);
      if (userId) await sessionIdentities.remember(sessionOrigin, userId);
    }
    if (outcome === 'invalid') {
      await sessionHints.forget(sessionOrigin);
      await sessionIdentities.forget(sessionOrigin);
    }
    const serialized = JSON.stringify({ ...claim, ok: true, value });
    if (new TextEncoder().encode(serialized).byteLength > MAX_COMPANION_RESULT_REQUEST_BYTES) {
      throw new Error('浏览器查询结果过大，无法安全回传');
    }
  } catch (error) {
    await post(current.token, `/result/${encodeURIComponent(job.id)}`, {
      ...claim,
      ok: false,
      message: String(error instanceof Error ? error.message : error).slice(0, 500),
    });
    scheduleHeartbeat();
    return true;
  }
  await post(current.token, `/result/${encodeURIComponent(job.id)}`, { ...claim, ok: true, value });
  if (outcome) scheduleHeartbeat();
  return true;
}

async function startPolling(initialConfig = null, sessionsAnnounced = false) {
  if (polling) return;
  polling = true;
  let nextConfig = initialConfig;
  let announceSessions = !sessionsAnnounced;
  let continuePolling = false;
  let consecutiveFailures = 0;
  try {
    for (let iteration = 0; iteration < POLL_BATCH_SIZE; iteration += 1) {
      const current = nextConfig || await config();
      nextConfig = null;
      if (!current.token) return;
      try {
        if (announceSessions) {
          await heartbeat(current);
          announceSessions = false;
        }
        await pollOnce(current);
        await updateStatus({ lastError: '' });
        consecutiveFailures = 0;
      } catch (error) {
        announceSessions = true;
        consecutiveFailures += 1;
        await updateStatus({ lastError: error instanceof Error ? error.message : String(error) });
        const policy = companionPollFailurePolicy(consecutiveFailures);
        if (policy.stop) return;
        await delay(policy.delayMs);
      }
    }
    continuePolling = true;
  } finally {
    polling = false;
    if (continuePolling) void startPolling();
  }
}

async function wake() {
  const current = await config();
  let sessionsAnnounced = false;
  try {
    const result = await heartbeat(current);
    sessionsAnnounced = result.connected === true;
    return result;
  } finally {
    startPolling(current, sessionsAnnounced);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  startPolling();
});
chrome.runtime.onStartup.addListener(() => startPolling());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) startPolling();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some(key => CONFIG_INVALIDATION_KEYS.has(key))) {
    configGeneration += 1;
    configCache = null;
    configPromise = null;
  }
  if (changes.validatedSessionOrigins) sessionHints.invalidate();
  if (changes.sessionUserIds) sessionIdentities.invalidate();
  if (changes[PROVIDER_ORIGINS_KEY]) providerWebsiteOrigins.invalidate();
  if (changes[PENDING_ORIGINS_KEY]) pendingWebsiteOrigins.invalidate();
  if (keys.some(key => WATCHED_ORIGIN_KEYS.has(key))) invalidateWatchedOrigins();
});
chrome.cookies.onChanged.addListener(change => {
  const domain = String(change.cookie?.domain || '').replace(/^\./, '');
  void watchedSessionOrigins().then(origins => {
    const origin = origins.find(value => new URL(value).hostname === domain || new URL(value).hostname.endsWith(`.${domain}`));
    if (origin) scheduleHeartbeat();
  });
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  try {
    const origin = new URL(tab.url).origin;
    void watchedSessionOrigins().then(origins => {
      if (origins.includes(origin)) scheduleHeartbeat();
    });
  } catch {}
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wake') {
    wake().then(sendResponse, error => sendResponse({ connected: false, error: error.message }));
    return true;
  }
  if (message?.type === 'status') {
    Promise.all([config(), chrome.storage.local.get(['lastHeartbeatAt', PROVIDER_ORIGINS_KEY, PENDING_ORIGINS_KEY])]).then(([current, state]) => {
      sendResponse({
        configured: Boolean(current.token),
        legacyPairingRequired: current.legacyPairingRequired,
        lastHeartbeatAt: state.lastHeartbeatAt || '',
        lastError: current.lastError,
        providerOrigins: normalizeSessionOrigins(state[PROVIDER_ORIGINS_KEY]),
        pendingOrigins: normalizeSessionOrigins(state[PENDING_ORIGINS_KEY]),
      });
    });
    return true;
  }
  if (message?.type === 'open-hub') {
    config().then(current => {
      if (!current.token) throw new Error('请先配置 Hub 连接码');
      return post(current.token, '/open-hub', {});
    }).then(() => sendResponse({ opened: true }), error => sendResponse({ opened: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
startPolling();
