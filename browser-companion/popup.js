const tokenInput = document.getElementById('token');
const status = document.getElementById('status');
const save = document.getElementById('save');
const openHub = document.getElementById('open-hub');
const grantSites = document.getElementById('grant-sites');
let websiteOrigins = [];

function normalizeOrigins(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) continue;
      if (!result.includes(url.origin)) result.push(url.origin);
    } catch {}
  }
  return result.slice(0, 64);
}

function permissionOrigins() {
  return websiteOrigins.map(origin => `${origin}/*`);
}

function show(message, tone = '') {
  status.textContent = message;
  status.className = `status ${tone}`.trim();
}

function hasWebsitePermissions() {
  const origins = permissionOrigins();
  if (!origins.length) return Promise.resolve(true);
  return new Promise(resolve => {
    chrome.permissions.contains({ origins }, granted => {
      void chrome.runtime.lastError;
      resolve(granted === true);
    });
  });
}

function updatePermissionButton(granted) {
  const count = websiteOrigins.length;
  grantSites.disabled = count === 0 || granted;
  grantSites.textContent = count === 0
    ? '暂无待授权站点'
    : granted
      ? `${count} 个站点已授权`
      : `授权 ${count} 个供应商站点`;
}

function requestWebsitePermissions(callback) {
  const origins = permissionOrigins();
  if (!origins.length) {
    callback(false, '当前模板没有需要授权的供应商站点');
    return;
  }
  chrome.permissions.request({ origins }, granted => {
    const error = chrome.runtime.lastError?.message || '';
    callback(granted === true, error);
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result || {});
    });
  });
}

async function refreshWebsiteOrigins(extra = {}) {
  const stored = await chrome.storage.local.get(['providerWebsiteOrigins', 'pendingWebsiteOrigins']);
  websiteOrigins = normalizeOrigins([
    ...(stored.providerWebsiteOrigins || []),
    ...(stored.pendingWebsiteOrigins || []),
    ...(extra.providerOrigins || []),
    ...(extra.pendingOrigins || []),
  ]);
  const granted = await hasWebsitePermissions();
  updatePermissionButton(granted);
  return granted;
}

async function wakeHub() {
  const result = await sendRuntimeMessage({ type: 'wake' });
  if (!result.connected) throw new Error(result.error || '未知错误');
  await refreshWebsiteOrigins(result);
  return result;
}

async function load() {
  const stored = await chrome.storage.local.get(['companionToken']);
  tokenInput.value = stored.companionToken || '';
  let result;
  try {
    result = await sendRuntimeMessage({ type: 'status' });
  } catch (error) {
    show(error.message, 'error');
    return;
  }
  const permissionsGranted = await refreshWebsiteOrigins(result);
  if (!result.configured) return show(result.legacyPairingRequired ? '安全协议已升级，请从 Hub 重新复制连接码' : '尚未配置 Hub 连接码');
  if (websiteOrigins.length && !permissionsGranted) {
    return show(`已连接本机 Hub，等待授权 ${websiteOrigins.length} 个供应商站点`, 'error');
  }
  if (result.lastError) return show(`连接异常：${result.lastError}`, 'error');
  const permissionText = websiteOrigins.length ? ' · 站点权限正常' : ' · 当前模板无需站点权限';
  show(result.lastHeartbeatAt
    ? `已连接 · ${new Date(result.lastHeartbeatAt).toLocaleTimeString()}${permissionText}`
    : '已配置，正在连接…', result.lastHeartbeatAt ? 'ok' : '');
}

save.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return show('连接码格式不正确', 'error');
  await chrome.storage.local.set({ companionToken: token, lastError: '' });
  await chrome.storage.local.remove(['hubToken', 'pairingUpgradeRequired']);
  show('正在连接…');
  try {
    await wakeHub();
    const granted = await hasWebsitePermissions();
    if (websiteOrigins.length && !granted) {
      show(`已连接 Hub；请授权 ${websiteOrigins.length} 个当前供应商站点`, 'error');
    } else {
      show('已连接到本机 Balance Hub', 'ok');
    }
  } catch (error) {
    show(`连接失败：${error.message}`, 'error');
  }
});

grantSites.addEventListener('click', () => {
  show('等待浏览器确认当前供应商站点权限…');
  requestWebsitePermissions(async (granted, error) => {
    updatePermissionButton(granted);
    if (!granted) return show(error || '未授予供应商网站查询权限', 'error');
    const stored = await chrome.storage.local.get(['pendingWebsiteOrigins']);
    const grantedSet = new Set(websiteOrigins);
    const pendingWebsiteOrigins = normalizeOrigins(stored.pendingWebsiteOrigins)
      .filter(origin => !grantedSet.has(origin));
    await chrome.storage.local.set({ pendingWebsiteOrigins });
    if (!tokenInput.value.trim()) return show('供应商站点权限已授权；请填写连接码并保存', 'ok');
    try {
      await wakeHub();
      show('当前供应商站点权限已授权，可以回到 Hub 刷新', 'ok');
    } catch (wakeError) {
      show(`权限已授权，Hub 重连失败：${wakeError.message}`, 'error');
    }
  });
});

openHub.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return show('请先填写连接码', 'error');
  try {
    const result = await sendRuntimeMessage({ type: 'open-hub' });
    if (!result.opened) throw new Error(result.error || 'Hub 未能打开');
  } catch (error) {
    show(`打开失败：${error.message}`, 'error');
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || (!changes.providerWebsiteOrigins && !changes.pendingWebsiteOrigins)) return;
  void refreshWebsiteOrigins();
});

load();
