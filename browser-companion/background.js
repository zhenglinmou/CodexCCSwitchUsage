import {
  browserJobTimeout,
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
  BROWSER_TAB_FALLBACK_RESERVE_MS,
  companionHandshake,
} from './protocol.js';

const HUB_ORIGIN = 'http://127.0.0.1:17891';
const POLL_ALARM = 'ccswitch-balance-companion-poll';
const HEARTBEAT_DEBOUNCE_MS = 350;
const HUB_REQUEST_TIMEOUT_MS = 10_000;
const HUB_POLL_TIMEOUT_MS = 30_000;
const POLL_BATCH_SIZE = 120;
const manifest = chrome.runtime.getManifest();
const sessionHints = new SessionHintStore(chrome.storage.local);
const sessionIdentities = new SessionIdentityStore(chrome.storage.local);
const instanceId = crypto.randomUUID();
let polling = false;
let lastErrorValue;
let statusUpdateChain = Promise.resolve();

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
  const stored = await chrome.storage.local.get(['hubToken', 'clientId', 'lastError']);
  let clientId = stored.clientId;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(clientId || ''))) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  lastErrorValue = String(stored.lastError || '');
  return { token: String(stored.hubToken || '').trim(), clientId, lastError: lastErrorValue };
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
    if (Object.hasOwn(update, 'lastError')) lastErrorValue = nextLastError;
    return true;
  });
  return statusUpdateChain;
}

function apiUrl(token, path) {
  return `${HUB_ORIGIN}/api/${encodeURIComponent(token)}${path}`;
}

async function requestHub(url, options = {}, timeoutMs = HUB_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = response.status === 204 ? null : await response.json();
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
  const { response, payload } = await requestHub(apiUrl(token, path), {
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
    browser: browserName(),
    version: manifest.version,
    ...companionHandshake(),
    sessions: await knownSessions(),
  };
  const result = await post(resolved.token, '/companion/heartbeat', payload);
  await updateStatus({ lastHeartbeatAt: new Date().toISOString(), lastError: '' });
  return { connected: true, configured: true, companion: result.companion };
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

async function fetchInsideTab(tabId, request, timeoutMs) {
  const targetUrl = new URL(request.requestPath || '/', request.baseUrl).href;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [{ targetUrl, headers: request.headers || {}, userHeader: request.userHeader || '', timeoutMs, maximumBytes: MAX_BROWSER_RESPONSE_BYTES }],
    func: async settings => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      let identityFound = false;
      const readText = async response => {
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > settings.maximumBytes) throw new Error('第三方网站响应过大');
        if (!response.body || typeof response.body.getReader !== 'function') {
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > settings.maximumBytes) throw new Error('第三方网站响应过大');
          return text;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
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
            chunks.push(decoder.decode(bytes, { stream: true }));
          }
          chunks.push(decoder.decode());
          return chunks.join('');
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
          headers: outgoing,
          signal: controller.signal,
        });
        return {
          status: response.status,
          url: response.url,
          text: await readText(response),
          identityFound,
        };
      } catch (error) {
        return { status: 0, url: location.href, text: '', identityFound, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
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
      headers: outgoing,
      signal: controller.signal,
    });
    return {
      status: response.status,
      url: response.url,
      text: await readLimitedResponseText(response),
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
  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  const preferred = selectReadySessionTab(tabs);
  if (!preferred) return focusLoginPage(request);
  const result = await fetchInsideTab(preferred.id, request, Math.max(1_000, deadline - Date.now()));
  const userId = browserSessionUserId(request, result);
  if (!userId) {
    const opened = await focusLoginPage(request);
    const outcome = browserSessionOutcome(request, result);
    return {
      ...opened,
      loginRequired: outcome === 'invalid',
      message: outcome === 'invalid'
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
  const userId = await sessionIdentities.get(origin);
  const direct = await fetchFromExtension(request, userId, remainingJobTime(deadline, BROWSER_TAB_FALLBACK_RESERVE_MS));
  const directOutcome = browserSessionOutcome(request, direct);
  if (isJsonText(direct.text) && (!request.userHeader || directOutcome === 'valid')) return direct;

  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  const preferred = selectReadySessionTab(tabs);
  if (!preferred) return request.userHeader && !userId ? { ...direct, identityMissing: true } : direct;
  const result = await fetchInsideTab(preferred.id, request, remainingJobTime(deadline));
  if (request.userHeader && !userId && result.identityFound !== true) return { ...result, identityMissing: true };
  return result;
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
    browser: browserName(),
    version: manifest.version,
    protocolVersion: String(handshake.protocolVersion),
  });
  for (const capability of handshake.capabilities) query.append('capability', capability);
  const { response, payload } = await requestHub(
    apiUrl(current.token, `/companion/job?${query}`),
    { cache: 'no-store' },
    HUB_POLL_TIMEOUT_MS,
  );
  if (response.status === 204) return true;
  if (!response.ok) throw new Error(String(payload?.message || `Balance Hub job poll returned HTTP ${response.status}`));
  const job = payload.job;
  assertHostJobCompatibility(job);
  const timeoutMs = browserJobTimeout(job);
  const deadline = Date.now() + timeoutMs;
  let value;
  let outcome = null;
  try {
    value = await withTimeout(executeJob(job, deadline), timeoutMs + 1_000, '第三方网站余额查询超时');
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
  } catch (error) {
    await post(current.token, `/companion/result/${encodeURIComponent(job.id)}`, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    scheduleHeartbeat();
    return true;
  }
  await post(current.token, `/companion/result/${encodeURIComponent(job.id)}`, { ok: true, value });
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
chrome.cookies.onChanged.addListener(change => {
  const domain = String(change.cookie?.domain || '').replace(/^\./, '');
  const origin = SESSION_ORIGINS.find(value => new URL(value).hostname === domain || new URL(value).hostname.endsWith(`.${domain}`));
  if (origin) scheduleHeartbeat();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (SESSION_ORIGINS.includes(origin)) scheduleHeartbeat();
  } catch {}
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wake') {
    wake().then(sendResponse, error => sendResponse({ connected: false, error: error.message }));
    return true;
  }
  if (message?.type === 'status') {
    Promise.all([config(), chrome.storage.local.get(['lastHeartbeatAt'])]).then(([current, state]) => {
      sendResponse({ configured: Boolean(current.token), lastHeartbeatAt: state.lastHeartbeatAt || '', lastError: current.lastError });
    });
    return true;
  }
  return false;
});

chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
startPolling();
