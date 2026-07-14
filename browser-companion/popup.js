const tokenInput = document.getElementById('token');
const status = document.getElementById('status');
const save = document.getElementById('save');
const openHub = document.getElementById('open-hub');

function show(message, tone = '') {
  status.textContent = message;
  status.className = `status ${tone}`.trim();
}

async function load() {
  const stored = await chrome.storage.local.get(['hubToken']);
  tokenInput.value = stored.hubToken || '';
  chrome.runtime.sendMessage({ type: 'status' }, result => {
    if (chrome.runtime.lastError) return show(chrome.runtime.lastError.message, 'error');
    if (!result?.configured) return show('尚未配置 Hub 连接码');
    if (result.lastError) return show(`连接异常：${result.lastError}`, 'error');
    show(result.lastHeartbeatAt ? `已连接 · ${new Date(result.lastHeartbeatAt).toLocaleTimeString()}` : '已配置，正在连接…', result.lastHeartbeatAt ? 'ok' : '');
  });
}

save.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return show('连接码格式不正确', 'error');
  await chrome.storage.local.set({ hubToken: token, lastError: '' });
  show('正在连接…');
  chrome.runtime.sendMessage({ type: 'wake' }, result => {
    if (chrome.runtime.lastError) return show(chrome.runtime.lastError.message, 'error');
    result?.connected ? show('已连接到本机 Balance Hub', 'ok') : show(`连接失败：${result?.error || '未知错误'}`, 'error');
  });
});

openHub.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return show('请先填写连接码', 'error');
  await chrome.tabs.create({ url: `http://127.0.0.1:17891/hub/${encodeURIComponent(token)}` });
});

load();
