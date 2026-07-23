const tokenInput = document.getElementById('token');
const status = document.getElementById('status');
const save = document.getElementById('save');
const openHub = document.getElementById('open-hub');
const grantSites = document.getElementById('grant-sites');
const websiteOrigins = Object.freeze(
  (chrome.runtime.getManifest().optional_host_permissions || [])
    .filter(value => String(value).startsWith('https://')),
);

function show(message, tone = '') {
  status.textContent = message;
  status.className = `status ${tone}`.trim();
}

function hasWebsitePermissions() {
  return new Promise(resolve => {
    chrome.permissions.contains({ origins: websiteOrigins }, granted => {
      void chrome.runtime.lastError;
      resolve(granted === true);
    });
  });
}

function updatePermissionButton(granted) {
  grantSites.disabled = granted;
  grantSites.textContent = granted ? '网站查询权限已授权' : '授予网站查询权限';
}

function requestWebsitePermissions(callback) {
  chrome.permissions.request({ origins: websiteOrigins }, granted => {
    const error = chrome.runtime.lastError?.message || '';
    callback(granted === true, error);
  });
}

function wakeHub(successMessage) {
  chrome.runtime.sendMessage({ type: 'wake' }, result => {
    if (chrome.runtime.lastError) return show(chrome.runtime.lastError.message, 'error');
    result?.connected ? show(successMessage, 'ok') : show(`连接失败：${result?.error || '未知错误'}`, 'error');
  });
}

async function load() {
  const [stored, permissionsGranted] = await Promise.all([
    chrome.storage.local.get(['hubToken']),
    hasWebsitePermissions(),
  ]);
  tokenInput.value = stored.hubToken || '';
  updatePermissionButton(permissionsGranted);
  chrome.runtime.sendMessage({ type: 'status' }, result => {
    if (chrome.runtime.lastError) return show(chrome.runtime.lastError.message, 'error');
    if (!result?.configured) return show('尚未配置 Hub 连接码');
    if (!permissionsGranted) return show('已连接本机 Hub，但缺少供应商网站查询权限；请点击上方按钮授权', 'error');
    if (result.lastError) return show(`连接异常：${result.lastError}`, 'error');
    show(result.lastHeartbeatAt ? `已连接 · ${new Date(result.lastHeartbeatAt).toLocaleTimeString()}` : '已配置，正在连接…', result.lastHeartbeatAt ? 'ok' : '');
  });
}

save.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return show('连接码格式不正确', 'error');
  requestWebsitePermissions(async (granted, error) => {
    updatePermissionButton(granted);
    if (!granted) return show(error || '未授予供应商网站查询权限，余额伴侣只能连接本机 Hub', 'error');
    await chrome.storage.local.set({ hubToken: token, lastError: '' });
    show('正在连接…');
    wakeHub('已连接到本机 Balance Hub，网站查询权限正常');
  });
});

grantSites.addEventListener('click', () => {
  show('等待 Edge 确认网站查询权限…');
  requestWebsitePermissions((granted, error) => {
    updatePermissionButton(granted);
    if (!granted) return show(error || '未授予网站查询权限，余额查询仍无法访问供应商官网', 'error');
    if (!tokenInput.value.trim()) return show('网站查询权限已授权；请填写连接码并保存', 'ok');
    wakeHub('网站查询权限已恢复，可以回到 Hub 刷新余额');
  });
});

openHub.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return show('请先填写连接码', 'error');
  await chrome.tabs.create({ url: `http://127.0.0.1:17891/hub/${encodeURIComponent(token)}` });
});

load();
