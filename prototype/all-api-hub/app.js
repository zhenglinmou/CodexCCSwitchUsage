(() => {
  'use strict';

  const providers = [
    {
      id: 'anyrouter', name: 'AnyRouter', initial: 'A', avatar: 'any', status: 'ok', statusLabel: '正常', current: true,
      used: 57.2, remaining: 142.8, total: 200, unit: '¥', unitAfter: false, progress: 28.6,
      message: '浏览器登录态有效，余额来自同源 Dashboard 接口。', source: '现有浏览器会话', updated: '刚刚更新',
      query: { label: 'New API Dashboard 余额', requestUrl: 'https://api.anyrouter.top/api/user/self', loginUrl: 'https://api.anyrouter.top/login', method: 'GET', authentication: '浏览器 Cookie + 数字用户 ID', executor: '现有 Edge / Chrome 浏览器', browser: '需要 · 复用当前浏览器 Cookie / WAF 登录态' },
      notes: ['伴侣只返回归一化后的响应结果。', '登录态由供应商响应确认；普通 WAF 失败不会清除已验证会话。']
    },
    {
      id: 'openai', name: 'OpenAI Platform', initial: 'O', avatar: 'openai', status: 'sync', statusLabel: '需要同步', current: false,
      used: 35.77, remaining: 84.23, total: 120, unit: '$', unitAfter: false, progress: 29.8,
      message: '浏览器伴侣已连接，等待一次显式会话同步。', source: 'OpenAI 用量接口', updated: '18 分钟前',
      query: { label: 'OpenAI 组织用量与信用额度', requestUrl: 'https://api.openai.com/v1/organization/costs', loginUrl: 'https://platform.openai.com/', method: 'GET', authentication: 'OpenAI 现有浏览器会话', executor: '浏览器伴侣 · 同源页面上下文', browser: '需要 · 当前伴侣已连接，等待会话同步' },
      notes: ['同步必须由用户明确点击，不会因打开 Hub 自动执行。', 'Token 不会进入 Hub 页面或写入缓存文件。']
    },
    {
      id: 'agentrouter', name: 'AgentRouter', initial: 'A', avatar: 'agent', status: 'degraded', statusLabel: '受限', current: false,
      used: 67.5, remaining: 32.5, total: 100, unit: '¥', unitAfter: false, progress: 67.5,
      message: '本次查询被 WAF 限制，已保留上次成功余额。', source: '上次缓存', updated: '36 分钟前',
      query: { label: 'New API Dashboard 余额（浏览器回退）', requestUrl: 'https://agentrouter.org/api/user/self', loginUrl: 'https://agentrouter.org/login', method: 'GET', authentication: '浏览器 Cookie + 用户 ID', executor: '现有 Edge / Chrome 浏览器', browser: '需要 · WAF 场景使用当前浏览器' },
      notes: ['普通网络或 WAF 失败保留最后一次成功余额。', '明确认证失败后才提示重新登录官网。']
    },
    {
      id: 'deepseek', name: 'DeepSeek', initial: 'D', avatar: 'deep', status: 'ok', statusLabel: '正常', current: false,
      used: 21.39, remaining: 28.61, total: 50, unit: '¥', unitAfter: false, progress: 42.8,
      message: '使用 CCSwitch 中配置的 API Key 直接查询官方余额。', source: '官方 API', updated: '2 分钟前',
      query: { label: '官方账户余额接口', requestUrl: 'https://api.deepseek.com/user/balance', loginUrl: 'https://platform.deepseek.com/', method: 'GET', authentication: 'CCSwitch API Key', executor: 'Balance Hub 本机宿主', browser: '不依赖浏览器' },
      notes: ['API Key 仅在本机宿主内存中参与请求。', '页面接收已归一化的已用、剩余、总额与单位。']
    },
    {
      id: 'cliproxy', name: 'CLIProxyAPI', initial: 'C', avatar: 'cli', status: 'idle', statusLabel: '等待查询', current: false,
      used: 1, remaining: 2, total: 3, unit: '账号', unitAfter: true, progress: 33.3,
      message: '检测到 3 个本地账号文件，尚未执行状态审计。', source: 'CLIProxyAPI 本地账号', updated: '尚未查询',
      query: { label: '本地账号文件状态', requestUrl: '本机 CLIProxyAPI 账号目录', loginUrl: '不需要网页登录', method: 'LOCAL', authentication: '本地账号元数据', executor: 'Balance Hub 本机宿主', browser: '不依赖浏览器' },
      notes: ['只读取账号状态与额度窗口，不在页面展示文件内容。', '查询动作不会修改本地账号文件。']
    },
    {
      id: 'packy', name: 'PackyCode', initial: 'P', avatar: 'packy', status: 'login', statusLabel: '需要登录', current: false,
      used: 88, remaining: 12, total: 100, unit: '¥', unitAfter: false, progress: 88,
      message: '官网会话已过期；登录后请手动点击刷新。', source: '上次缓存', updated: '2 小时前',
      query: { label: '供应商 Dashboard 余额', requestUrl: 'https://www.packyapi.com/api/user/self', loginUrl: 'https://www.packyapi.com/login', method: 'GET', authentication: '浏览器 Cookie', executor: '现有 Edge / Chrome 浏览器', browser: '需要 · 当前认证已失效' },
      notes: ['官网登录动作只打开已验证的 HTTPS 登录页。', '登录完成后仍需用户手动刷新，Hub 不会后台追踪标签页。']
    },
    {
      id: 'window', name: 'Codex 周额度', initial: 'W', avatar: 'window', status: 'ok', statusLabel: '正常', current: false,
      used: 37, remaining: 63, total: 100, unit: '%', unitAfter: true, progress: 37,
      message: '当前 7 天额度窗口，预计 3 天 14 小时后重置。', source: '供应商 API', updated: '5 分钟前',
      query: { label: '订阅窗口额度', requestUrl: 'https://provider.example.com/api/quota/window', loginUrl: '不需要网页登录', method: 'GET', authentication: 'CCSwitch API Key', executor: 'Balance Hub 本机宿主', browser: '不依赖浏览器' },
      notes: ['窗口额度统一换算为已用与剩余百分比。', '重置时间来自供应商响应，不在本地推断登录信息。']
    },
    {
      id: 'generic', name: 'Custom Gateway', initial: 'G', avatar: 'generic', status: 'ok', statusLabel: '正常', current: false,
      used: 112, remaining: null, total: null, unit: '请求', unitAfter: true, progress: 0,
      message: '供应商没有余额端点；显示 API 健康检查与本地请求统计。', source: 'API 健康检查 + 本地统计', updated: '1 分钟前',
      query: { label: '通用 API 健康检查', requestUrl: 'https://gateway.example.com/v1/models', loginUrl: '不需要网页登录', method: 'GET', authentication: 'CCSwitch API Key 能力检查', executor: 'Balance Hub 本机宿主', browser: '不依赖浏览器' },
      notes: ['没有已知余额接口时不会伪造余额。', '可用状态来自模型端点健康检查，请求数来自本机统计。']
    }
  ];

  const pageNames = {
    integration: '接入预览', overview: '余额总览', providers: '供应商', usage: '用量统计', companion: '浏览器伴侣', methods: '查询说明'
  };
  const sourceLabels = {
    '官方 API': '官方 API', '现有浏览器会话': '现有浏览器会话', 'OpenAI 用量接口': 'OpenAI 用量接口',
    '上次缓存': '上次缓存', 'CLIProxyAPI 本地账号': 'CLIProxyAPI 本地账号', '供应商 API': '供应商 API',
    'API 健康检查 + 本地统计': 'API 健康检查 + 本地统计'
  };
  const usageRanges = {
    7: { requests: '12,482', input: '48.2M', output: '6.8M', cost: '$38.24', title: '近 7 天趋势', bars: [34,48,41,58,52,76,63,81,70,92,74,88,83,96] },
    30: { requests: '48,216', input: '182.7M', output: '24.6M', cost: '$142.80', title: '近 30 天趋势', bars: [41,53,47,64,59,72,68,78,62,88,79,91,85,94] },
    90: { requests: '142,806', input: '544.3M', output: '71.8M', cost: '$418.62', title: '近 90 天趋势', bars: [38,46,52,49,61,57,69,66,73,78,76,84,89,93] }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const providerGrid = $('#provider-grid');
  const providerPreviewGrid = $('#provider-preview-grid');
  const providerEmpty = $('#provider-empty');
  const providerSearch = $('#provider-search');
  const providerDialog = $('#provider-dialog');
  const toast = $('#toast');
  const toastMessage = $('#toast-message');
  let activeFilter = 'all';
  let toastTimer = 0;
  let currentDialogProvider = null;
  let companionConnected = true;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  }

  function icon(name, className = '') {
    return `<svg${className ? ` class="${className}"` : ''} aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  function showToast(message) {
    toastMessage.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  function formatValue(value, unit, after = false) {
    if (value == null || value === '') return '—';
    const numeric = Number(value);
    const digits = Number.isInteger(numeric) ? 0 : 2;
    const formatted = Number.isFinite(numeric) ? numeric.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: 2 }) : value;
    return after ? `${formatted} ${unit}` : `${unit}${formatted}`;
  }

  function statusTone(status) {
    if (status === 'ok') return 'ok';
    if (status === 'loading') return 'loading';
    if (status === 'idle') return 'idle';
    if (status === 'error') return 'error';
    return 'warning';
  }

  function isAttention(provider) {
    return ['sync', 'degraded', 'login', 'error'].includes(provider.status);
  }

  function providerAction(provider) {
    if (provider.status === 'sync') return { label: '同步会话', action: 'sync', primary: true };
    if (provider.status === 'login') return { label: '官网登录', action: 'login', primary: true };
    if (provider.status === 'degraded') return { label: '重新登录', action: 'login', primary: false };
    if (provider.status === 'idle') return { label: '开始查询', action: 'refresh', primary: true };
    return null;
  }

  function providerCard(provider) {
    const action = providerAction(provider);
    const metrics = [
      ['已用', formatValue(provider.used, provider.unit, provider.unitAfter), ''],
      ['剩余', formatValue(provider.remaining, provider.unit, provider.unitAfter), 'remaining'],
      ['总额', formatValue(provider.total, provider.unit, provider.unitAfter), '']
    ];
    const metricHtml = metrics.map(([label, value, className]) => `<div class="provider-metric ${className}"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
    const badges = `<span class="status-badge ${statusTone(provider.status)}">${escapeHtml(provider.statusLabel)}</span>${provider.current ? '<span class="status-badge current">CCSwitch 当前</span>' : ''}`;
    const actionHtml = action ? `<button class="mini-button ${action.primary ? 'primary' : ''}" type="button" data-provider-action="${action.action}" data-provider-id="${provider.id}">${escapeHtml(action.label)}</button>` : '';
    const refreshLabel = provider.status === 'loading' ? '查询中' : '刷新';
    return `
      <article class="provider-card ${provider.current ? 'is-current' : ''}" data-provider-card="${provider.id}">
        <div class="provider-card-head">
          <div class="provider-identity"><span class="provider-avatar ${provider.avatar}">${provider.initial}</span><div><h2>${escapeHtml(provider.name)}</h2><div class="provider-badges">${badges}</div></div></div>
          <button class="provider-menu" type="button" data-provider-open="${provider.id}" aria-label="查看 ${escapeHtml(provider.name)} 详情">•••</button>
        </div>
        <div class="provider-metrics">${metricHtml}</div>
        <div class="provider-progress"><i style="width:${Math.max(0, Math.min(100, provider.progress || 0))}%"></i></div>
        <p class="provider-message">${escapeHtml(provider.message)}</p>
        <div class="provider-card-foot">
          <div class="provider-source"><span>${escapeHtml(sourceLabels[provider.source] || provider.source)}</span><span>${escapeHtml(provider.updated)}</span></div>
          <div class="provider-actions"><button class="mini-button" type="button" data-provider-open="${provider.id}">查看</button>${actionHtml}<button class="mini-button ${provider.status === 'loading' ? 'is-loading' : ''}" type="button" data-provider-action="refresh" data-provider-id="${provider.id}" ${provider.status === 'loading' ? 'disabled' : ''}>${icon('refresh')}${refreshLabel}</button></div>
        </div>
      </article>`;
  }

  function previewCard(provider) {
    return `<button class="preview-provider" type="button" data-provider-open="${provider.id}">
      <div class="preview-provider-head"><span class="provider-avatar ${provider.avatar}">${provider.initial}</span><div><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.statusLabel)}</small></div></div>
      <strong>${escapeHtml(formatValue(provider.remaining, provider.unit, provider.unitAfter))}</strong><span>可用余额 · ${escapeHtml(provider.updated)}</span>
    </button>`;
  }

  function renderProviders() {
    const query = (providerSearch?.value || '').trim().toLocaleLowerCase('zh-CN');
    const shown = providers.filter(provider => {
      const filterMatches = activeFilter === 'all' || provider.status === activeFilter || (activeFilter === 'attention' && isAttention(provider));
      const queryMatches = !query || `${provider.name} ${provider.source} ${provider.statusLabel}`.toLocaleLowerCase('zh-CN').includes(query);
      return filterMatches && queryMatches;
    });
    providerGrid.innerHTML = shown.map(providerCard).join('');
    providerEmpty.hidden = shown.length > 0;
    providerGrid.hidden = shown.length === 0;
    updateSummary();
  }

  function renderPreviews() {
    const previewIds = ['anyrouter', 'deepseek', 'openai', 'agentrouter'];
    providerPreviewGrid.innerHTML = previewIds.map(id => previewCard(providers.find(provider => provider.id === id))).join('');
  }

  function updateSummary() {
    const stats = { all: providers.length, ok: providers.filter(item => item.status === 'ok').length, attention: providers.filter(isAttention).length };
    Object.entries(stats).forEach(([key, value]) => $$(`[data-stat="${key}"]`).forEach(node => { node.textContent = value; }));
    $$('.filter-tab').forEach(tab => {
      const key = tab.dataset.filter;
      const count = key === 'all' ? stats.all : key === 'ok' ? stats.ok : key === 'attention' ? stats.attention : providers.filter(item => item.status === 'idle').length;
      const countNode = $('span', tab);
      if (countNode) countNode.textContent = count;
    });
  }

  function showView(view, updateLocation = true) {
    const next = pageNames[view] ? view : 'integration';
    $$('.view').forEach(section => section.classList.toggle('is-active', section.dataset.view === next));
    $$('.nav-item').forEach(item => item.classList.toggle('is-active', item.dataset.viewTarget === next));
    $('#page-title').textContent = pageNames[next];
    $('#main-content').scrollTop = 0;
    closeSidebar();
    if (updateLocation) history.replaceState(null, '', `#${next}`);
    if (next === 'providers') renderProviders();
    if (next === 'overview') renderPreviews();
  }

  function setComposerMode(mode) {
    const safeMode = ['full', 'compact', 'icon'].includes(mode) ? mode : 'full';
    $('.codex-window').dataset.composerPreview = safeMode;
    $$('.mode-button').forEach(button => button.classList.toggle('is-active', button.dataset.composerMode === safeMode));
    $('#mini-popover').classList.remove('is-open');
  }

  async function refreshComposerBalance(button) {
    if (button.classList.contains('is-loading')) return;
    button.classList.add('is-loading');
    button.disabled = true;
    await wait(720);
    $$('.balance-readout strong, .mini-popover-head strong').forEach(node => { node.textContent = '¥145.20'; });
    button.classList.remove('is-loading');
    button.disabled = false;
    showToast('AnyRouter 余额已刷新；Hub 没有被打开');
  }

  async function refreshProvider(id) {
    const provider = providers.find(item => item.id === id);
    if (!provider || provider.status === 'loading') return;
    const previous = { status: provider.status, statusLabel: provider.statusLabel, message: provider.message };
    provider.status = 'loading';
    provider.statusLabel = '查询中';
    provider.message = '正在使用已配置的查询方式获取最新结果…';
    renderProviders();
    showToast(`已开始查询 ${provider.name}`);
    await wait(950);
    provider.status = 'ok';
    provider.statusLabel = '正常';
    provider.message = previous.status === 'idle' ? '本地账号状态审计完成，2 个账号可用。' : '静态演示：最新余额查询成功。';
    provider.updated = '刚刚更新';
    if (provider.remaining != null && typeof provider.remaining === 'number') {
      provider.remaining = Number((provider.remaining + (provider.unitAfter ? 0 : .4)).toFixed(2));
    }
    renderProviders();
    renderPreviews();
    showToast(`${provider.name} 已更新`);
    if (currentDialogProvider?.id === id && providerDialog.open) openProviderDialog(id);
  }

  async function resolveProviderAction(id, action) {
    const provider = providers.find(item => item.id === id);
    if (!provider) return;
    if (action === 'refresh') return refreshProvider(id);
    if (action === 'login') {
      showToast(`静态原型：此处将打开 ${provider.name} 的 HTTPS 登录页`);
      provider.status = 'loading'; provider.statusLabel = '等待登录'; provider.message = '已准备打开官网登录页；登录后需手动刷新。';
      renderProviders();
      await wait(900);
      provider.status = 'login'; provider.statusLabel = '需要登录';
      renderProviders();
      return;
    }
    if (action === 'sync') {
      provider.status = 'loading'; provider.statusLabel = '同步中'; provider.message = '正在从已连接浏览器同步现有会话…';
      renderProviders();
      showToast('正在同步 OpenAI 现有会话');
      await wait(1000);
      provider.status = 'ok'; provider.statusLabel = '正常'; provider.message = '现有浏览器会话同步成功。'; provider.updated = '刚刚更新';
      renderProviders(); renderPreviews(); updateSummary();
      showToast(`${provider.name} 会话同步成功`);
    }
  }

  async function refreshAll(button) {
    if (button.classList.contains('is-loading')) return;
    const original = $('span', button)?.textContent || '刷新全部';
    button.classList.add('is-loading');
    const label = $('span', button);
    if (label) label.textContent = '正在刷新…';
    $$('[data-action="refresh-all"]').forEach(item => { item.disabled = true; });
    showToast('已开始刷新全部供应商（静态演示）');
    await wait(1200);
    providers.filter(item => item.status === 'ok').forEach(item => { item.updated = '刚刚更新'; });
    button.classList.remove('is-loading');
    if (label) label.textContent = original;
    $$('[data-action="refresh-all"]').forEach(item => { item.disabled = false; });
    renderProviders(); renderPreviews();
    showToast('全部查询已完成；需登录的供应商仍保留原状态');
  }

  function fieldRow(label, value, wide = false, code = false) {
    return `<div class="${wide ? 'wide' : ''}"><dt>${escapeHtml(label)}</dt><dd class="${code ? 'code' : ''}">${escapeHtml(value || '—')}</dd></div>`;
  }

  function openProviderDialog(id) {
    const provider = providers.find(item => item.id === id);
    if (!provider) return;
    currentDialogProvider = provider;
    $('#dialog-provider-name').textContent = provider.name;
    $('#dialog-provider-subtitle').textContent = provider.query.label;
    $('#dialog-provider-avatar').textContent = provider.initial;
    $('#dialog-provider-avatar').className = `dialog-provider-avatar provider-avatar ${provider.avatar}`;
    const status = $('#dialog-status');
    status.className = `status-badge ${statusTone(provider.status)}`;
    status.textContent = provider.statusLabel;
    $('#dialog-balance').textContent = formatValue(provider.remaining, provider.unit, provider.unitAfter);
    $('#dialog-updated').textContent = provider.updated;
    $('#dialog-method-fields').innerHTML = [
      fieldRow('请求地址', provider.query.requestUrl, true, true),
      fieldRow('官方登录页', provider.query.loginUrl, true, true),
      fieldRow('HTTP 方法', provider.query.method),
      fieldRow('认证方式', provider.query.authentication),
      fieldRow('执行位置', provider.query.executor, true),
      fieldRow('Cookie / WAF', provider.query.browser, true),
      fieldRow('当前状态', provider.statusLabel),
      fieldRow('当前结果来源', provider.source)
    ].join('');
    $('#dialog-notes').innerHTML = provider.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('');
    const primary = $('#dialog-primary');
    primary.dataset.providerId = provider.id;
    if (typeof providerDialog.showModal === 'function') {
      if (!providerDialog.open) providerDialog.showModal();
    } else {
      providerDialog.setAttribute('open', '');
    }
  }

  function closeProviderDialog() {
    if (typeof providerDialog.close === 'function' && providerDialog.open) providerDialog.close();
    else providerDialog.removeAttribute('open');
  }

  function renderUsage(range) {
    const data = usageRanges[range] || usageRanges[7];
    $('#metric-requests').textContent = data.requests;
    $('#metric-input').textContent = data.input;
    $('#metric-output').textContent = data.output;
    $('#metric-cost').textContent = data.cost;
    $('#chart-range-title').textContent = data.title;
    $('#bar-chart').innerHTML = data.bars.map((height, index) => {
      const secondary = Math.max(12, Math.round(height * (.34 + ((index % 3) * .05))));
      const label = index % 2 === 0 ? `${index + 1}` : '';
      return `<div class="bar-group"><i style="height:${height}%"></i><i style="height:${secondary}%"></i><span>${label}</span></div>`;
    }).join('');
    $$('.range-switch button').forEach(button => button.classList.toggle('is-active', Number(button.dataset.range) === Number(range)));
  }

  async function copyPairingCode() {
    const code = 'CCSWITCH-DEMO-7F2A';
    try {
      await navigator.clipboard.writeText(code);
      showToast(companionConnected ? '连接码已复制；当前伴侣已自动连接，无需重复配置' : '连接码已复制，可在浏览器伴侣中保存');
    } catch {
      showToast('静态原型：连接码复制动作已触发');
    }
  }

  function setCompanionState(connected) {
    companionConnected = connected;
    $$('.companion-button-label').forEach(node => { node.textContent = connected ? '浏览器伴侣已连接' : '连接现有浏览器'; });
    const hero = $('.companion-hero');
    if (hero) hero.classList.toggle('is-disconnected', !connected);
  }

  function openSidebar() {
    $('#sidebar').classList.add('is-open');
    $('#sidebar-scrim').classList.add('is-visible');
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('is-open');
    $('#sidebar-scrim').classList.remove('is-visible');
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('all-api-hub-theme', next); } catch {}
    showToast(next === 'light' ? '已切换到暖色浅色主题' : '已切换到深色主题');
  }

  document.addEventListener('click', event => {
    const viewTarget = event.target.closest('[data-view-target]');
    if (viewTarget) {
      showView(viewTarget.dataset.viewTarget);
      return;
    }
    const modeTarget = event.target.closest('[data-composer-mode]');
    if (modeTarget) {
      setComposerMode(modeTarget.dataset.composerMode);
      return;
    }
    const providerOpen = event.target.closest('[data-provider-open]');
    if (providerOpen) {
      openProviderDialog(providerOpen.dataset.providerOpen);
      return;
    }
    const providerActionTarget = event.target.closest('[data-provider-action]');
    if (providerActionTarget) {
      resolveProviderAction(providerActionTarget.dataset.providerId, providerActionTarget.dataset.providerAction);
      return;
    }
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.dataset.action;
    if (action === 'open-hub') {
      $('#mini-popover').classList.remove('is-open');
      showView('overview');
      showToast('已通过独立 All API Hub 按钮进入余额中心');
    } else if (action === 'refresh-balance') refreshComposerBalance(actionTarget);
    else if (action === 'toggle-mini-popover') $('#mini-popover').classList.toggle('is-open');
    else if (action === 'refresh-all') refreshAll(actionTarget);
    else if (action === 'copy-pairing') copyPairingCode();
    else if (action === 'test-companion') showToast('伴侣心跳正常 · Edge · 3 个已验证来源');
    else if (action === 'disconnect-companion') {
      setCompanionState(!companionConnected);
      actionTarget.textContent = companionConnected ? '断开演示' : '重新连接';
      showToast(companionConnected ? '浏览器伴侣已重新连接' : '静态演示：浏览器伴侣已断开');
    } else if (action === 'download-demo') showToast('静态原型：CSV 导出已触发，不会写入真实文件');
  });

  $$('.filter-tab').forEach(tab => tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    $$('.filter-tab').forEach(item => item.classList.toggle('is-active', item === tab));
    renderProviders();
  }));
  providerSearch.addEventListener('input', renderProviders);
  $$('.range-switch button').forEach(button => button.addEventListener('click', () => renderUsage(button.dataset.range)));
  $$('.method-toggle').forEach(toggle => toggle.addEventListener('click', () => {
    const card = toggle.closest('.method-card');
    const shouldOpen = !card.classList.contains('is-open');
    $$('.method-card').forEach(item => {
      item.classList.toggle('is-open', item === card && shouldOpen);
      $('.method-toggle', item).setAttribute('aria-expanded', String(item === card && shouldOpen));
    });
  }));
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#mobile-menu').addEventListener('click', openSidebar);
  $('#sidebar-scrim').addEventListener('click', closeSidebar);
  $('#dialog-close').addEventListener('click', closeProviderDialog);
  $('#dialog-secondary').addEventListener('click', closeProviderDialog);
  $('#dialog-primary').addEventListener('click', event => {
    const id = event.currentTarget.dataset.providerId;
    closeProviderDialog();
    refreshProvider(id);
  });
  providerDialog.addEventListener('click', event => {
    if (event.target === providerDialog) closeProviderDialog();
  });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));

  try {
    const storedTheme = localStorage.getItem('all-api-hub-theme');
    if (storedTheme === 'light' || storedTheme === 'dark') document.documentElement.dataset.theme = storedTheme;
  } catch {}
  renderProviders();
  renderPreviews();
  renderUsage(7);
  showView(location.hash.slice(1) || 'integration', false);
  document.body.dataset.ready = 'true';
})();
