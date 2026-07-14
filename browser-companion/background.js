const HUB_ORIGIN = 'http://127.0.0.1:17891';
const SESSION_ORIGINS = ['https://agentrouter.org', 'https://anyrouter.top', 'https://chatgpt.com'];
const POLL_ALARM = 'ccswitch-balance-companion-poll';
const manifest = chrome.runtime.getManifest();
let polling = false;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

async function knownSessions() {
  const sessions = [];
  for (const origin of SESSION_ORIGINS) {
    try {
      const cookies = await chrome.cookies.getAll({ url: origin });
      if (cookies.some(cookie => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000)) sessions.push(origin);
    } catch {}
  }
  return sessions;
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
    browser: browserName(),
    version: manifest.version,
    sessions: await knownSessions(),
  };
  const result = await post(current.token, '/companion/heartbeat', payload);
  await chrome.storage.local.set({ lastHeartbeatAt: new Date().toISOString(), lastError: '' });
  return { connected: true, configured: true, companion: result.companion };
}

async function notifySession(origin) {
  const current = await config();
  if (!current.token || !SESSION_ORIGINS.includes(origin)) return;
  try {
    await post(current.token, '/companion/session', { clientId: current.clientId, origin });
  } catch {}
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

async function fetchInsideTab(tabId, request) {
  const targetUrl = new URL(request.requestPath || '/', request.baseUrl).href;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    args: [{ targetUrl, headers: request.headers || {}, userHeader: request.userHeader || '' }],
    func: async settings => {
      try {
        const outgoing = { Accept: 'application/json', ...settings.headers };
        if (settings.userHeader && !outgoing[settings.userHeader]) {
          let user = {};
          try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
          if (user.id != null) outgoing[settings.userHeader] = String(user.id);
        }
        const response = await fetch(settings.targetUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: outgoing,
        });
        return {
          status: response.status,
          url: response.url,
          text: (await response.text()).slice(0, 2_000_000),
        };
      } catch (error) {
        return { status: 0, url: location.href, text: '', error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  return results?.[0]?.result || { status: 0, text: '', error: '网页脚本没有返回结果' };
}

function isJsonText(value) {
  try { JSON.parse(String(value || '').trim()); return true; } catch { return false; }
}

async function queryThroughCurrentBrowser(request) {
  const origin = new URL(request.baseUrl).origin;
  const tabs = (await matchingTabs(origin)).filter(tab => tab.id != null);
  if (!tabs.length) {
    return { loginRequired: true, message: '请先在当前浏览器中打开并登录该网站；查询失败不会自动跳转' };
  }
  const preferred = tabs.find(tab => tab.active) || tabs[0];
  let result = await fetchInsideTab(preferred.id, request);
  if (isJsonText(result.text) || !request.navigateRequest) return result;

  let temporaryTab = null;
  try {
    temporaryTab = await chrome.tabs.create({ url: origin, active: false });
    await waitForTab(temporaryTab.id, Math.min(Number(request.waitMs) || 30_000, 40_000));
    result = await fetchInsideTab(temporaryTab.id, request);
    return result;
  } finally {
    if (temporaryTab?.id != null) {
      try { await chrome.tabs.remove(temporaryTab.id); } catch {}
    }
  }
}

async function openLogin(request) {
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

async function executeJob(job) {
  if (job.type === 'open-login') return openLogin(job.request);
  if (job.type === 'query-json') return queryThroughCurrentBrowser(job.request);
  throw new Error(`不支持的浏览器任务: ${job.type}`);
}

async function pollOnce() {
  const current = await config();
  if (!current.token) return false;
  const query = new URLSearchParams({ clientId: current.clientId, browser: browserName(), version: manifest.version });
  const response = await fetch(apiUrl(current.token, `/companion/job?${query}`), { cache: 'no-store' });
  if (response.status === 204) return true;
  if (!response.ok) throw new Error(`Balance Hub job poll returned HTTP ${response.status}`);
  const payload = await response.json();
  const job = payload.job;
  try {
    const value = await executeJob(job);
    await post(current.token, `/companion/result/${encodeURIComponent(job.id)}`, { ok: true, value });
    if (value?.origin) await notifySession(value.origin);
  } catch (error) {
    await post(current.token, `/companion/result/${encodeURIComponent(job.id)}`, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

async function startPolling() {
  if (polling) return;
  polling = true;
  try {
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const current = await config();
      if (!current.token) break;
      try {
        await pollOnce();
        await chrome.storage.local.set({ lastError: '' });
      } catch (error) {
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
  if (origin) notifySession(origin);
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  try {
    const origin = new URL(tab.url).origin;
    if (SESSION_ORIGINS.includes(origin)) notifySession(origin);
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
