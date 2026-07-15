import {
  browserJobTimeout,
  browserSessionOutcome,
  browserSessionUserId,
  normalizeSessionOrigins,
  selectReadySessionTab,
  SESSION_ORIGINS,
  SessionHintStore,
  SessionIdentityStore,
} from './session-state.js';

const HUB_ORIGIN = 'http://127.0.0.1:17891';
const POLL_ALARM = 'ccswitch-balance-companion-poll';
const manifest = chrome.runtime.getManifest();
const sessionHints = new SessionHintStore(chrome.storage.local);
const sessionIdentities = new SessionIdentityStore(chrome.storage.local);
const instanceId = crypto.randomUUID();
let polling = false;

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
  const stored = await chrome.storage.local.get(['hubToken', 'clientId']);
  let clientId = stored.clientId;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(clientId || ''))) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return { token: String(stored.hubToken || '').trim(), clientId };
}

function apiUrl(token, path) {
  return `${HUB_ORIGIN}/api/${encodeURIComponent(token)}${path}`;
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
  const response = await fetch(apiUrl(token, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Balance Hub callback returned HTTP ${response.status}`);
  return response.json();
}

async function heartbeat() {
  const current = await config();
  if (!current.token) return { connected: false, configured: false };
  const payload = {
    clientId: current.clientId,
    instanceId,
    browser: browserName(),
    version: manifest.version,
    sessions: await knownSessions(),
  };
  const result = await post(current.token, '/companion/heartbeat', payload);
  await chrome.storage.local.set({ lastHeartbeatAt: new Date().toISOString(), lastError: '' });
  return { connected: true, configured: true, companion: result.companion };
}

async function matchingTabs(origin) {
  try { return await chrome.tabs.query({ url: `${origin}/*` }); } catch { return []; }
}

async function waitForTab(tabId, timeoutMs) {
  const deadline = Date.now() + Math.max(2_000, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
    } catch { break; }
    await delay(250);
  }
  throw new Error('等待第三方网站页面加载超时');
}

async function fetchInsideTab(tabId, request, timeoutMs) {
  const targetUrl = new URL(request.requestPath || '/', request.baseUrl).href;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [{ targetUrl, headers: request.headers || {}, userHeader: request.userHeader || '', timeoutMs }],
    func: async settings => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      let identityFound = false;
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
          text: (await response.text()).slice(0, 2_000_000),
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
  try {
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
      text: (await response.text()).slice(0, 2_000_000),
    };
  } catch (error) {
    return { status: 0, url: targetUrl, text: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function syncNewApiSession(request, deadline) {
  const origin = new URL(request.baseUrl).origin;
  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  let preferred = selectReadySessionTab(tabs);
  let temporaryTab = null;
  try {
    if (!preferred) {
      temporaryTab = await chrome.tabs.create({ url: origin, active: false });
      preferred = await waitForTab(temporaryTab.id, Math.max(1_000, deadline - Date.now()));
    }
    const result = await fetchInsideTab(preferred.id, request, Math.max(1_000, deadline - Date.now()));
    const userId = browserSessionUserId(request, result);
    if (!userId) {
      const outcome = browserSessionOutcome(request, result);
      return {
        synced: false,
        opened: false,
        origin,
        loginRequired: outcome === 'invalid',
        message: outcome === 'invalid'
          ? '现有浏览器 Cookie 已失效，请先在官网完成登录'
          : String(result.error || '未能从现有浏览器同步数字用户 ID'),
      };
    }
    await sessionIdentities.remember(origin, userId);
    await sessionHints.remember(origin);
    heartbeat().catch(() => {});
    return { synced: true, opened: false, origin };
  } finally {
    if (temporaryTab?.id != null) {
      try { await chrome.tabs.remove(temporaryTab.id); } catch {}
    }
  }
}

async function queryThroughCurrentBrowser(request, deadline) {
  const origin = new URL(request.baseUrl).origin;
  const userId = await sessionIdentities.get(origin);
  const direct = await fetchFromExtension(request, userId, Math.max(1_000, deadline - Date.now()));
  const directOutcome = browserSessionOutcome(request, direct);
  if (isJsonText(direct.text) && (!request.userHeader || directOutcome === 'valid')) return direct;

  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  const preferred = selectReadySessionTab(tabs);
  if (!preferred) return request.userHeader && !userId ? { ...direct, identityMissing: true } : direct;
  const result = await fetchInsideTab(preferred.id, request, Math.max(1_000, deadline - Date.now()));
  if (request.userHeader && !userId && result.identityFound !== true) return { ...result, identityMissing: true };
  return result;
}

async function openLogin(request, deadline) {
  if (request.userHeader) return syncNewApiSession(request, deadline);
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

async function executeJob(job, deadline) {
  if (job.type === 'open-login') return openLogin(job.request, deadline);
  if (job.type === 'query-json') return queryThroughCurrentBrowser(job.request, deadline);
  throw new Error(`不支持的浏览器任务: ${job.type}`);
}

async function pollOnce() {
  const current = await config();
  if (!current.token) return false;
  const query = new URLSearchParams({ clientId: current.clientId, instanceId, browser: browserName(), version: manifest.version });
  for (const origin of await knownSessions()) query.append('session', origin);
  const response = await fetch(apiUrl(current.token, `/companion/job?${query}`), { cache: 'no-store' });
  if (response.status === 204) return true;
  if (!response.ok) throw new Error(`Balance Hub job poll returned HTTP ${response.status}`);
  const payload = await response.json();
  const job = payload.job;
  const timeoutMs = browserJobTimeout(job.request);
  const deadline = Date.now() + timeoutMs;
  try {
    const value = await withTimeout(executeJob(job, deadline), timeoutMs + 1_000, '第三方网站余额查询超时');
    const outcome = job.type === 'query-json' ? browserSessionOutcome(job.request, value) : null;
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
    await post(current.token, `/companion/result/${encodeURIComponent(job.id)}`, { ok: true, value });
    if (outcome) heartbeat().catch(() => {});
  } catch (error) {
    await post(current.token, `/companion/result/${encodeURIComponent(job.id)}`, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    await heartbeat().catch(() => {});
  }
  return true;
}

async function startPolling() {
  if (polling) return;
  polling = true;
  let announceSessions = true;
  try {
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const current = await config();
      if (!current.token) break;
      try {
        if (announceSessions) {
          await heartbeat();
          announceSessions = false;
        }
        await pollOnce();
        await chrome.storage.local.set({ lastError: '' });
      } catch (error) {
        announceSessions = true;
        await chrome.storage.local.set({ lastError: error instanceof Error ? error.message : String(error) });
        await delay(2_000);
      }
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  startPolling();
});
chrome.runtime.onStartup.addListener(() => startPolling());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) startPolling();
});
chrome.cookies.onChanged.addListener(change => {
  const domain = String(change.cookie?.domain || '').replace(/^\./, '');
  const origin = SESSION_ORIGINS.find(value => new URL(value).hostname === domain || new URL(value).hostname.endsWith(`.${domain}`));
  if (origin) heartbeat().catch(() => {});
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (SESSION_ORIGINS.includes(origin)) heartbeat().catch(() => {});
  } catch {}
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'wake') {
    startPolling();
    heartbeat().then(sendResponse, error => sendResponse({ connected: false, error: error.message }));
    return true;
  }
  if (message?.type === 'status') {
    Promise.all([config(), chrome.storage.local.get(['lastHeartbeatAt', 'lastError'])]).then(([current, state]) => {
      sendResponse({ configured: Boolean(current.token), lastHeartbeatAt: state.lastHeartbeatAt || '', lastError: state.lastError || '' });
    });
    return true;
  }
  return false;
});

chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
startPolling();
