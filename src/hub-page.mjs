export function hubLoginLink(item = {}) {
  let href = '';
  try {
    const url = new URL(String(item.loginUrl || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    href = url.href;
  } catch {
    return null;
  }
  const attention = item.websiteLoginRequired === true
    || (item.sessionSyncRequired !== true && ['error', 'degraded', 'login-required'].includes(String(item.status || '')));
  return { href, label: attention ? '重新登录官网' : '官网登录', primary: attention };
}

export function resolveProviderBrowser(item = {}, clients = [], preferences = {}) {
  const targets = (Array.isArray(clients) ? clients : []).filter(client => client?.ref && client?.browser);
  const aliases = preferences?.browserAliases && typeof preferences.browserAliases === 'object'
    ? preferences.browserAliases
    : {};
  const byRef = ref => targets.find(target => target.ref === ref) || null;
  const known = (target, reason) => ({
    target,
    clientRef: target.ref,
    browser: target.browser,
    label: target.label || aliases[target.ref] || target.browser,
    connected: true,
    state: 'known',
    reason,
  });
  const offline = (clientRef, browser, reason) => ({
    target: null,
    clientRef,
    browser,
    label: aliases[clientRef] || browser || '已选择浏览器',
    connected: false,
    state: 'offline',
    reason,
  });

  const bindingRef = String(item?.accountBinding?.clientRef || '');
  if (bindingRef) {
    const target = byRef(bindingRef);
    return target ? known(target, 'binding') : offline(bindingRef, String(item.accountBinding?.browser || ''), 'binding');
  }

  const stored = preferences?.providerBrowsers?.[String(item?.id || '')];
  const storedRef = String(stored?.clientRef || '');
  if (storedRef) {
    const target = byRef(storedRef);
    return target ? known(target, 'preference') : offline(storedRef, String(stored?.browser || ''), 'preference');
  }

  const resultRef = String(item?.usage?.accountClientRef || '');
  if (resultRef) {
    const target = byRef(resultRef);
    return target ? known(target, 'result') : offline(resultRef, String(item?.usage?.accountBrowser || ''), 'result');
  }

  const resultBrowser = String(item?.usage?.accountBrowser || '').trim();
  const resultTargets = resultBrowser
    ? targets.filter(target => String(target.browser).toLowerCase() === resultBrowser.toLowerCase())
    : [];
  if (resultTargets.length === 1) return known(resultTargets[0], 'result');
  if (resultBrowser && resultTargets.length === 0) return offline('', resultBrowser, 'result');

  let origin = '';
  for (const value of [item?.loginUrl, item?.queryMethod?.requestUrl]) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol === 'https:') {
        origin = url.origin;
        break;
      }
    } catch {}
  }
  const sessionTargets = origin
    ? targets.filter(target => Array.isArray(target.sessions) && target.sessions.includes(origin))
    : [];
  if (sessionTargets.length === 1) return known(sessionTargets[0], 'session');
  if (resultBrowser && resultTargets.length > 1) {
    const narrowed = sessionTargets.filter(target => String(target.browser).toLowerCase() === resultBrowser.toLowerCase());
    if (narrowed.length === 1) return known(narrowed[0], 'result');
  }
  if (sessionTargets.length > 1 || resultTargets.length > 1) {
    return { target: null, clientRef: '', browser: '', label: '未指定', connected: true, state: 'ambiguous', reason: 'multiple' };
  }
  if (targets.length === 1) return known(targets[0], 'only');
  if (targets.length === 0) {
    return { target: null, clientRef: '', browser: '', label: '未连接', connected: false, state: 'disconnected', reason: 'none' };
  }
  return { target: null, clientRef: '', browser: '', label: '未指定', connected: true, state: 'unassigned', reason: 'none' };
}

export function browserTaskKind(item = {}) {
  if (item.accountBindingRequired === true) return 'binding';
  if (item.sessionSyncRequired === true) return 'sync';
  if (item.websiteLoginRequired === true) return 'authentication';
  if (String(item.status || '') === 'login-required' && item.loginSupported === true) {
    return item.sessionSyncSupported === true ? 'sync' : 'authentication';
  }
  return '';
}

export function hubProviderMessage(item = {}, includeTechnical = false) {
  const raw = String(item?.message || item?.usage?.extra || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!raw) return String(item?.status || '') === 'idle' ? '等待第一次查询' : '';
  const normalized = raw.toLowerCase();
  let friendly = raw;
  if (normalized.includes('active_codex_subscription_not_found')) {
    friendly = '当前账号没有可用的 Codex 订阅';
  } else if (normalized.includes('failed to fetch') || normalized.includes('fetch failed')) {
    friendly = '暂时无法连接供应商，请检查网络或浏览器网站权限';
  } else if (normalized.includes('timed out') || normalized.includes('timeout') || normalized.includes('超时')) {
    friendly = '供应商响应超时，请稍后重试';
  } else if (normalized.includes('unauthorized') || normalized.includes('authentication failed') || /(^|\D)401(\D|$)/.test(normalized)) {
    friendly = '认证已失效，请重新登录或检查 API Key';
  } else if (normalized.includes('forbidden') || /(^|\D)403(\D|$)/.test(normalized)) {
    friendly = '供应商拒绝了请求，请检查账号权限或网站验证';
  } else if (normalized.includes('record not found')) {
    friendly = '暂未找到可显示的消费记录';
  } else if (/^[a-z0-9_.:-]+$/i.test(raw)) {
    friendly = '供应商返回了未识别状态';
  }
  return includeTechnical && friendly !== raw ? `${friendly}；技术信息：${raw}` : friendly;
}

export function hubProviderNeedsAttention(item = {}) {
  const status = String(item?.status || '');
  const retryingPreviousFailure = status === 'loading' && Boolean(item?.lastAttemptAt);
  return Boolean(
    item?.accountBindingRequired
    || item?.websiteLoginRequired
    || item?.sessionSyncRequired
    || retryingPreviousFailure
    || ['error', 'login-required', 'degraded'].includes(status)
  );
}

export function buildHubPage({ apiBase, nonce }) {
  const safeApiBase = JSON.stringify(String(apiBase));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>CCSwitch Balance Hub</title>
  <style>
    :root{color-scheme:dark;--bg:#0d0f12;--surface:#14171b;--surface-2:#1a1e23;--surface-3:#20252b;--line:#2a3037;--line-strong:#3b434d;--text:#f1f3f5;--muted:#9aa2ac;--soft:#cbd0d6;--accent:#62a0ea;--green:#58c987;--amber:#e5ad5b;--red:#ec7373;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}
    body{margin:0;min-width:320px;background:var(--bg);color:var(--text);font-size:14px}
    button,input,select,a{font:inherit;letter-spacing:0}
    button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .shell{width:min(1380px,calc(100% - 32px));margin:0 auto;padding:24px 0 40px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-bottom:18px;border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:baseline;gap:12px;min-width:0}
    .brand-mark{display:inline-flex;align-items:center;gap:7px;color:var(--accent);font-size:11px;font-weight:700;text-transform:uppercase;white-space:nowrap}
    .brand-mark::before{content:"";width:8px;height:8px;border-radius:2px;background:var(--accent)}
    h1{margin:0;font-size:24px;line-height:1.2;letter-spacing:0;white-space:nowrap}
    .version{color:var(--muted);font-size:12px;white-space:nowrap}
    .actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);color:var(--text);text-decoration:none;cursor:pointer;white-space:nowrap}
    .button:hover{border-color:var(--line-strong);background:var(--surface-3)}
    .button.primary{border-color:var(--accent);background:var(--accent);color:#08111c;font-weight:650}
    .button.primary:hover{background:#77b0f0}
    .button:disabled{opacity:.55;cursor:wait}
    .button[hidden]{display:none}
    .button.small{min-height:30px;padding:0 10px;font-size:12px}
    .button.quiet{background:transparent}
    .button-count{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 5px;border-radius:9px;background:rgba(236,115,115,.16);color:var(--red);font-size:11px}
    .button-count:empty{display:none}
    .icon-button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;font-size:17px;line-height:1}
    .icon-button:hover{border-color:var(--line-strong);color:var(--text);background:var(--surface-2)}
    .icon-button.favorite{border-color:transparent;font-size:18px}
    .icon-button.favorite.active{color:var(--amber)}
    .overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:18px 0;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    .stat{min-width:0;padding:12px 15px;border-right:1px solid var(--line)}
    .stat:last-child{border-right:0}
    .stat-label{color:var(--muted);font-size:11px}
    .stat-value{display:block;margin-top:3px;font-size:18px;font-weight:700;letter-spacing:0}
    .activation{display:flex;align-items:center;gap:18px;margin:0 0 18px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
    .activation[hidden]{display:none}
    .activation-copy{min-width:150px}
    .activation-title{margin:0;color:var(--soft);font-size:13px;letter-spacing:0}
    .activation-subtitle{margin:3px 0 0;color:var(--muted);font-size:11px}
    .activation-steps{display:flex;align-items:center;gap:14px;min-width:0;flex:1;flex-wrap:wrap}
    .activation-step{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;white-space:nowrap}
    .activation-step strong{color:var(--soft);font-weight:600}
    .activation-dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}
    .activation-dot.ok{background:var(--green)}
    .activation-dot.warning{background:var(--amber)}
    .activation-dot.error{background:var(--red)}
    .activation-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}
    .workbench{min-width:0}
    .toolbar{display:grid;grid-template-columns:minmax(220px,1fr) auto auto;align-items:center;gap:10px;margin-bottom:10px}
    .toolbar-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px}
    .search-input,.sort-select{height:36px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)}
    .search-input{width:100%;padding:0 12px}
    .search-input::placeholder{color:#747d87}
    .sort-select{min-width:142px;padding:0 32px 0 10px}
    .view-switch{display:inline-flex;align-items:center;padding:2px;border:1px solid var(--line);border-radius:7px;background:var(--surface)}
    .view-button{display:inline-flex;align-items:center;justify-content:center;width:31px;height:30px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--muted);cursor:pointer;font-size:17px;line-height:1}
    .view-button:hover{color:var(--text);background:var(--surface-2)}
    .view-button.active{color:var(--text);background:var(--surface-3)}
    .tabs{display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--line);border-radius:7px;background:var(--surface)}
    .tab{height:28px;padding:0 9px;border:0;border-radius:5px;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;white-space:nowrap}
    .tab.active{background:var(--surface-3);color:var(--text)}
    .tab-count{margin-left:4px;color:#737d88}
    .result-line{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:30px;color:var(--muted);font-size:12px}
    .browser-tasks{margin:0 0 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}
    .browser-tasks[hidden]{display:none}
    .task-center-head{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:45px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--surface-2)}
    .task-center-title{display:flex;align-items:baseline;gap:8px;margin:0;font-size:13px;letter-spacing:0}
    .task-center-count{color:var(--muted);font-size:11px;font-weight:400}
    .task-group{display:grid;grid-template-columns:minmax(150px,.65fr) minmax(220px,1.35fr) auto;align-items:center;gap:14px;min-height:58px;padding:9px 12px;border-bottom:1px solid var(--line)}
    .task-group:last-child{border-bottom:0}
    .task-browser{min-width:0}
    .task-browser-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--soft);font-size:13px;font-weight:650}
    .task-browser-meta{display:block;margin-top:3px;color:var(--muted);font-size:11px}
    .task-items{display:flex;min-width:0;gap:6px;flex-wrap:wrap}
    .task-item{display:inline-flex;align-items:center;max-width:100%;min-height:24px;padding:2px 7px;border-radius:5px;background:var(--surface-2);color:var(--muted);font-size:11px;line-height:1.3}
    .task-item strong{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--soft);font-weight:600}
    .task-item-status{margin-left:5px;color:var(--amber)}
    .task-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
    .provider-list{border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}
    .provider-columns,.provider-main{display:grid;grid-template-columns:38px minmax(190px,1.35fr) 104px minmax(178px,1fr) minmax(174px,1.05fr) 90px minmax(214px,1fr);align-items:center;gap:12px}
    .provider-columns{min-height:35px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--surface-2);color:var(--muted);font-size:11px}
    .provider-row{border-bottom:1px solid var(--line)}
    .provider-row:last-child{border-bottom:0}
    .provider-row.current{box-shadow:inset 3px 0 0 var(--accent)}
    .provider-row.attention{background:rgba(229,173,91,.025)}
    .provider-row.ignored{background:rgba(154,162,172,.035)}
    .provider-row.ignored .provider-main{opacity:.78}
    .provider-main{min-height:72px;padding:9px 12px}
    .provider-cell{min-width:0}
    .provider-identity{display:flex;align-items:center;gap:7px;min-width:0}
    .provider-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:650}
    .provider-meta,.provider-message,.cell-secondary{margin-top:4px;color:var(--muted);font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .provider-message{color:#858e98}
    .current-label{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:rgba(98,160,234,.12);color:var(--accent);font-size:10px;white-space:nowrap}
    .badge{display:inline-flex;align-items:center;gap:6px;min-height:23px;padding:0 8px;border-radius:5px;background:var(--surface-3);color:var(--muted);font-size:11px;white-space:nowrap}
    .badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
    .badge.ok{color:var(--green);background:rgba(88,201,135,.1)}
    .badge.loading{color:var(--accent);background:rgba(98,160,234,.1)}
    .badge.warning{color:var(--amber);background:rgba(229,173,91,.1)}
    .badge.error{color:var(--red);background:rgba(236,115,115,.1)}
    .browser-status{display:block;max-width:100%;margin-top:6px;color:var(--muted);font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .browser-status.known{color:#8dbbea}
    .browser-status.choice{color:var(--amber)}
    .browser-status.offline{color:var(--red)}
    .quota-primary{font-size:14px;font-weight:700;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .quota-primary.remaining{color:#9dc4f3}
    .card-metrics{display:none}
    .progress{width:100%;height:4px;margin-top:7px;border-radius:2px;background:var(--surface-3);overflow:hidden}
    .progress i{display:block;height:100%;background:var(--accent)}
    .source-line{color:var(--soft);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .latency{font-variant-numeric:tabular-nums;color:var(--soft);font-size:12px}
    .row-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
    .row-actions .button{max-width:120px;overflow:hidden;text-overflow:ellipsis}
    .provider-detail{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:10px 12px 12px 62px;border-top:1px solid rgba(42,48,55,.72);background:rgba(10,12,14,.22)}
    .provider-detail[hidden]{display:none}
    .detail-copy{min-width:160px;max-width:520px;color:var(--muted);font-size:12px;line-height:1.5}
    .detail-actions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
    .binding-current{display:inline-flex;align-items:center;min-height:30px;padding:0 9px;border:1px solid var(--line);border-radius:6px;color:var(--green);font-size:12px;white-space:nowrap}
    .empty{padding:56px 20px;color:var(--muted);text-align:center}
    .provider-list.cards{border:0;background:transparent;overflow:visible}
    .provider-list.cards .provider-columns{display:none}
    .provider-list.cards #provider-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .provider-list.cards .provider-row{min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}
    .provider-list.cards .provider-row.current{box-shadow:inset 3px 0 0 var(--accent)}
    .provider-list.cards .provider-main{grid-template-columns:32px minmax(0,1fr) auto;grid-template-areas:"favorite identity status" ". meta status" "quota quota quota" "message message message" "source source actions" "latency latency actions";grid-template-rows:auto auto minmax(88px,auto) minmax(36px,auto) auto auto;align-items:start;gap:5px 10px;min-height:252px;padding:16px}
    .provider-list.cards .favorite{grid-area:favorite}
    .provider-list.cards .provider-main>.provider-cell:nth-of-type(1){display:contents}
    .provider-list.cards .provider-identity{grid-area:identity;align-self:center;flex-wrap:wrap}
    .provider-list.cards .provider-name{overflow:visible;text-overflow:clip;white-space:normal;font-size:16px}
    .provider-list.cards .provider-meta{grid-area:meta;margin-top:0}
    .provider-list.cards .cell-status{grid-area:status;max-width:170px;justify-self:end;text-align:right}
    .provider-list.cards .cell-quota{grid-area:quota;align-self:center;padding:9px 0 4px}
    .provider-list.cards .compact-quota{display:none}
    .provider-list.cards .card-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .provider-list.cards .card-metric{min-width:0;padding:10px;border-radius:6px;background:var(--surface-2)}
    .provider-list.cards .card-metric-label{display:block;color:var(--muted);font-size:11px}
    .provider-list.cards .card-metric-value{display:block;margin-top:5px;overflow:hidden;color:var(--soft);font-size:15px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
    .provider-list.cards .card-metric-value.remaining{color:#9dc4f3}
    .provider-list.cards .provider-message{grid-area:message;min-height:36px;margin-top:1px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;overflow:hidden;text-overflow:ellipsis;line-height:18px}
    .provider-list.cards .cell-source{grid-area:source;align-self:end}
    .provider-list.cards .cell-latency{grid-area:latency;align-self:end;text-align:right}
    .provider-list.cards .row-actions{grid-area:actions;justify-content:flex-end;align-self:end;flex-wrap:wrap}
    .provider-list.cards .provider-detail{padding:12px 15px;flex-direction:column}
    .provider-list.cards .detail-actions{justify-content:flex-start}
    .provider-list.cards .empty{grid-column:1/-1;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    .privacy{display:flex;align-items:center;justify-content:flex-end;gap:6px 10px;flex-wrap:wrap;margin:14px 0 0;color:#78818b;font-size:11px;line-height:1.5;text-align:right}
    .privacy-link{padding:0;border:0;background:transparent;color:var(--accent);cursor:pointer;font-size:11px}
    .privacy-link:hover{text-decoration:underline}
    dialog{color:var(--text)}
    dialog::backdrop{background:rgba(4,6,8,.7)}
    .method-dialog{width:min(760px,calc(100% - 24px));max-height:min(820px,calc(100vh - 32px));padding:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 24px 70px rgba(0,0,0,.5);overflow:hidden}
    .method-panel{display:flex;max-height:min(820px,calc(100vh - 32px));flex-direction:column}
    .dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:17px 18px 14px;border-bottom:1px solid var(--line)}
    .dialog-kicker{display:block;margin-bottom:5px;color:var(--accent);font-size:10px;font-weight:700;text-transform:uppercase}
    .dialog-title{margin:0;font-size:18px;letter-spacing:0}
    .dialog-subtitle{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.5}
    .dialog-close{width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);color:var(--muted);cursor:pointer;font-size:19px}
    .dialog-close:hover{color:var(--text);border-color:var(--line-strong)}
    .method-body{padding:16px 18px 18px;overflow:auto}
    .template-config{margin:0 0 15px;padding:0 0 15px;border-bottom:1px solid var(--line)}
    .template-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .template-field{display:block;min-width:0}
    .template-label{display:block;margin:0 0 6px;color:var(--muted);font-size:11px}
    .template-select{width:100%;height:36px;padding:0 32px 0 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);color:var(--text);font:inherit;font-size:13px}
    .template-description{display:block;min-height:34px;margin-top:7px;color:var(--muted);font-size:11px;line-height:1.5}
    .template-actions{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:11px}
    .template-result{margin-top:11px;padding:10px 12px;border-left:3px solid var(--accent);background:var(--surface-2);font-size:12px}
    .template-result[hidden]{display:none}
    .probe-group+.probe-group{margin-top:8px}
    .probe-title{color:var(--soft);font-weight:650}
    .probe-line{margin-top:4px;color:var(--muted);line-height:1.5;overflow-wrap:anywhere}
    .probe-line.success{color:var(--green)}
    .probe-line.needs-action{color:var(--amber)}
    .probe-line.failed{color:var(--red)}
    .method-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}
    .method-row{min-width:0;padding:10px 11px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2)}
    .method-row.wide{grid-column:1/-1}
    .method-label{color:var(--muted);font-size:11px}
    .method-value{margin:5px 0 0;color:var(--soft);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
    .method-value.code{font-family:"Cascadia Code",Consolas,monospace;font-size:12px}
    .method-notes{margin-top:14px;padding:12px 14px;border:1px solid var(--line);border-radius:6px;background:rgba(8,10,12,.22)}
    .method-notes h3{margin:0 0 7px;font-size:12px;color:var(--soft)}
    .method-notes ul{margin:0;padding-left:18px;color:var(--muted);font-size:12px;line-height:1.65}
    .method-warning{margin:13px 0 0;color:#7e8791;font-size:11px;line-height:1.55}
    .trust-list{display:grid;gap:16px;margin:0;padding:0;list-style:none}
    .trust-list strong{display:block;margin-bottom:4px;color:var(--soft);font-size:13px}
    .trust-list span{display:block;color:var(--muted);font-size:12px;line-height:1.6}
    .diagnostic-dialog{width:min(560px,100%);height:100vh;max-height:100vh;margin:0 0 0 auto;padding:0;border:0;border-left:1px solid var(--line);border-radius:0;background:var(--surface);box-shadow:-24px 0 60px rgba(0,0,0,.45)}
    .diagnostic-panel{display:flex;height:100%;flex-direction:column}
    .diagnostic-body{overflow:auto}
    .diagnostic-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}
    .diagnostic-section{padding:16px 18px;border-bottom:1px solid var(--line)}
    .diagnostic-section:last-child{border-bottom:0}
    .section-title{margin:0 0 10px;color:var(--soft);font-size:12px;font-weight:700}
    .check-row,.profile-row,.issue-row,.origin-row{display:grid;align-items:center;gap:10px;min-height:48px;padding:8px 0;border-bottom:1px solid rgba(42,48,55,.65)}
    .check-row:last-child,.profile-row:last-child,.issue-row:last-child,.origin-row:last-child{border-bottom:0}
    .check-row{grid-template-columns:22px minmax(0,1fr) auto}
    .check-dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
    .check-dot.ok{background:var(--green)}
    .check-dot.warning{background:var(--amber)}
    .check-dot.error{background:var(--red)}
    .check-title{color:var(--soft);font-size:12px;font-weight:650}
    .check-detail{margin-top:3px;color:var(--muted);font-size:11px;line-height:1.4;overflow-wrap:anywhere}
    .profile-row{grid-template-columns:minmax(0,1fr) minmax(150px,.8fr) auto}
    .profile-name{font-size:12px;font-weight:650;color:var(--soft)}
    .profile-meta{margin-top:3px;color:var(--muted);font-size:11px}
    .alias-input{width:100%;height:32px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:12px}
    .issue-row{grid-template-columns:minmax(0,1fr) auto}
    .issue-row.highlight{background:rgba(229,173,91,.07)}
    .issue-title{color:var(--soft);font-size:12px;font-weight:650}
    .issue-detail{margin-top:3px;color:var(--muted);font-size:11px;line-height:1.4}
    .origin-row{grid-template-columns:minmax(0,1fr) auto;font-size:11px}
    .origin-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--soft);font-family:"Cascadia Code",Consolas,monospace}
    .origin-state{color:var(--muted);white-space:nowrap}
    .origin-state.ok{color:var(--green)}
    .diagnostic-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:auto;padding:13px 18px;border-top:1px solid var(--line);background:var(--surface)}
    .toast{position:fixed;right:18px;bottom:18px;z-index:10;max-width:min(400px,calc(100vw - 36px));padding:10px 13px;border:1px solid var(--line);border-radius:6px;background:var(--surface-3);color:var(--text);box-shadow:0 15px 36px rgba(0,0,0,.38);font-size:12px;opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease}
    .toast.show{opacity:1;transform:translateY(0)}
    @media(max-width:1080px){.provider-columns,.provider-main{grid-template-columns:38px minmax(180px,1.25fr) 100px minmax(170px,1fr) minmax(145px,.9fr) minmax(214px,1fr)}.column-latency,.cell-latency{display:none}.provider-list.cards .cell-latency{display:block}}
    @media(max-width:840px){.shell{width:min(100% - 20px,1380px);padding-top:16px}.topbar{align-items:flex-start}.brand{display:block}.brand-mark{margin-bottom:4px}.activation{align-items:flex-start;flex-wrap:wrap}.activation-actions{width:100%;justify-content:flex-start}.toolbar{grid-template-columns:1fr auto}.tabs{grid-column:1/-1;overflow-x:auto}.result-line{align-items:flex-start;flex-direction:column;gap:2px}.result-line span{max-width:100%;overflow-wrap:anywhere}.task-group{grid-template-columns:minmax(130px,.55fr) minmax(180px,1.45fr)}.task-actions{grid-column:1/-1;justify-content:flex-start}.provider-columns{display:none}.provider-main{grid-template-columns:36px minmax(0,1fr);gap:8px 9px;min-height:86px}.provider-main>.favorite{grid-column:1;grid-row:1}.provider-main>.provider-cell:nth-of-type(1){grid-column:2;grid-row:1}.cell-status{grid-column:2;grid-row:2;justify-self:start}.cell-quota{grid-column:2;grid-row:3;padding-right:0}.cell-source{grid-column:2;grid-row:4;align-self:start}.row-actions{grid-column:2;grid-row:5;justify-content:flex-start;flex-direction:row}.provider-detail{padding-left:55px;flex-direction:column}.detail-actions{justify-content:flex-start}.provider-list.cards #provider-list{grid-template-columns:1fr}.provider-list.cards .provider-detail{padding-left:15px}.overview{grid-template-columns:repeat(2,1fr)}.stat:nth-child(2){border-right:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}}
    @media(max-width:560px){.topbar{display:block}.actions{justify-content:flex-start;margin-top:14px}.toolbar{grid-template-columns:1fr}.toolbar-controls{justify-content:space-between}.sort-select{width:100%;min-width:0}.overview{margin-top:14px}.task-center-head{align-items:flex-start;flex-direction:column;gap:2px}.task-group{grid-template-columns:1fr}.task-actions{grid-column:auto;justify-content:flex-start}.provider-main{padding-left:7px;padding-right:7px}.provider-detail{padding-left:49px}.provider-list.cards .provider-main{grid-template-columns:32px minmax(0,1fr);grid-template-areas:"favorite identity" ". meta" ". status" "quota quota" "message message" "source source" "latency latency" "actions actions";grid-template-rows:auto;min-height:0;padding:13px 11px}.provider-list.cards .cell-status{justify-self:start;max-width:100%;text-align:left}.provider-list.cards .cell-latency{text-align:left}.provider-list.cards .row-actions{justify-content:flex-start}.provider-list.cards .card-metrics{gap:6px}.provider-list.cards .card-metric{padding:8px}.provider-list.cards .card-metric-value{font-size:13px}.provider-list.cards .provider-detail{padding:11px}.diagnostic-dialog{width:100vw;max-width:100vw;min-width:0;margin:0}.diagnostic-panel,.diagnostic-body{min-width:0}.diagnostic-summary{align-items:flex-start;flex-direction:column}.profile-row{grid-template-columns:minmax(0,1fr) auto}.profile-row>div:first-child{grid-column:1/-1}.alias-input{grid-column:1;min-width:0}.diagnostic-footer{flex-wrap:wrap}.method-fields,.template-grid{grid-template-columns:1fr}.method-row.wide{grid-column:auto}.dialog-head,.method-body{padding-left:14px;padding-right:14px}.dialog-head>div{min-width:0}.dialog-close{flex:0 0 auto}}
    @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f5f6;--surface:#fff;--surface-2:#f5f6f7;--surface-3:#e9ecef;--line:#d9dde1;--line-strong:#b8c0c8;--text:#171a1e;--muted:#68717b;--soft:#343a41;--accent:#286faf;--green:#23834d;--amber:#a46916;--red:#b84242}.provider-row.attention{background:#fffaf2}.provider-detail{background:#fafbfc}.button.primary{color:#fff}.diagnostic-dialog::backdrop,.method-dialog::backdrop{background:rgba(32,38,44,.42)}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">CCSwitch</span><h1>Balance Hub</h1><span id="app-version" class="version">v2</span></div>
      <div class="actions">
        <button id="copy-companion" class="button quiet" type="button">连接浏览器</button>
        <button id="open-diagnostics" class="button" type="button">系统检查 <span id="diagnostic-count" class="button-count"></span></button>
        <button id="refresh-all" class="button primary" type="button">刷新全部</button>
      </div>
    </header>
    <section class="overview" aria-label="供应商汇总">
      <div class="stat"><span class="stat-label">使用中供应商</span><strong id="count-all" class="stat-value">--</strong></div>
      <div class="stat"><span class="stat-label">查询正常</span><strong id="count-ok" class="stat-value">--</strong></div>
      <div class="stat"><span class="stat-label">需要处理</span><strong id="count-attention" class="stat-value">--</strong></div>
      <div class="stat"><span class="stat-label">浏览器连接</span><strong id="count-browser" class="stat-value">--</strong></div>
    </section>
    <section id="activation" class="activation" aria-labelledby="activation-title" hidden>
      <div class="activation-copy"><h2 id="activation-title" class="activation-title">首次检查</h2><p class="activation-subtitle">本机连接状态</p></div>
      <div class="activation-steps">
        <span class="activation-step"><i id="activation-codex-dot" class="activation-dot"></i><strong>Codex</strong><span id="activation-codex-state">检查中</span></span>
        <span class="activation-step"><i id="activation-provider-dot" class="activation-dot"></i><strong>当前供应商</strong><span id="activation-provider-state">检查中</span></span>
        <span class="activation-step"><i id="activation-browser-dot" class="activation-dot"></i><strong>浏览器伴侣</strong><span id="activation-browser-state">检查中</span></span>
      </div>
      <div class="activation-actions"><button id="activation-refresh" class="button small" type="button">查询当前供应商</button><button id="activation-browser" class="button small" type="button">连接浏览器</button><button id="activation-complete" class="button small primary" type="button">完成</button></div>
    </section>
    <section class="workbench" aria-label="供应商工作台">
      <div class="toolbar">
        <input id="provider-search" class="search-input" type="search" autocomplete="off" placeholder="搜索供应商名称、域名或状态" aria-label="搜索供应商">
        <div class="tabs" role="tablist" aria-label="供应商筛选">
          <button class="tab active" data-filter="all" type="button" aria-selected="true">全部<span class="tab-count" data-count="all"></span></button>
          <button class="tab" data-filter="favorites" type="button" aria-selected="false">收藏<span class="tab-count" data-count="favorites"></span></button>
          <button class="tab" data-filter="attention" type="button" aria-selected="false">需处理<span class="tab-count" data-count="attention"></span></button>
          <button class="tab" data-filter="ok" type="button" aria-selected="false">正常<span class="tab-count" data-count="ok"></span></button>
          <button class="tab" data-filter="browser" type="button" aria-selected="false">浏览器型<span class="tab-count" data-count="browser"></span></button>
          <button class="tab" data-filter="ignored" type="button" aria-selected="false">已忽略<span class="tab-count" data-count="ignored"></span></button>
        </div>
        <div class="toolbar-controls">
          <select id="provider-sort" class="sort-select" aria-label="供应商排序">
            <option value="smart">推荐顺序</option>
            <option value="name">名称</option>
            <option value="remaining">剩余比例最低</option>
            <option value="updated">最近更新</option>
            <option value="latency">查询最快</option>
          </select>
          <div class="view-switch" role="group" aria-label="供应商视图">
            <button class="view-button" data-view="cards" type="button" title="宽松卡片" aria-label="宽松卡片" aria-pressed="true">▦</button>
            <button class="view-button" data-view="compact" type="button" title="紧凑列表" aria-label="紧凑列表" aria-pressed="false">☷</button>
          </div>
        </div>
      </div>
      <div class="result-line"><span id="result-count">等待本机服务…</span><span id="sync">正在读取状态…</span></div>
      <section id="browser-tasks" class="browser-tasks" aria-labelledby="browser-task-title" hidden>
        <header class="task-center-head"><h2 id="browser-task-title" class="task-center-title">浏览器待办 <span id="browser-task-count" class="task-center-count"></span></h2></header>
        <div id="browser-task-groups"></div>
      </section>
      <section id="provider-surface" class="provider-list cards" aria-live="polite">
        <div class="provider-columns" aria-hidden="true"><span></span><span>供应商</span><span>状态</span><span>额度</span><span>来源与更新</span><span class="column-latency">耗时</span><span></span></div>
        <div id="provider-list"></div>
      </section>
    </section>
    <p class="privacy"><span>本机只读 · Cookie 与认证原文不进入 Hub 页面</span><button id="open-trust" class="privacy-link" type="button">隐私与安全</button></p>
  </main>
  <dialog id="diagnostic-dialog" class="diagnostic-dialog" aria-labelledby="diagnostic-title">
    <div class="diagnostic-panel">
      <header class="dialog-head"><div><span class="dialog-kicker">Local health</span><h2 id="diagnostic-title" class="dialog-title">系统检查</h2><p id="diagnostic-subtitle" class="dialog-subtitle"></p></div><button id="diagnostic-close" class="dialog-close" type="button" aria-label="关闭">×</button></header>
      <div class="diagnostic-body">
        <div id="diagnostic-summary" class="diagnostic-summary"></div>
        <section class="diagnostic-section"><h3 class="section-title">运行状态</h3><div id="diagnostic-checks"></div></section>
        <section class="diagnostic-section"><h3 class="section-title">浏览器实例</h3><div id="diagnostic-profiles"></div></section>
        <section class="diagnostic-section"><h3 class="section-title">需要处理的供应商</h3><div id="diagnostic-issues"></div></section>
        <section class="diagnostic-section"><h3 class="section-title">浏览器站点</h3><div id="diagnostic-origins"></div></section>
      </div>
      <footer class="diagnostic-footer"><button id="diagnostic-recheck" class="button" type="button">重新检查</button><button id="copy-diagnostics" class="button primary" type="button">复制脱敏报告</button></footer>
    </div>
  </dialog>
  <dialog id="method-dialog" class="method-dialog" aria-labelledby="method-title">
    <div class="method-panel">
      <header class="dialog-head"><div><span class="dialog-kicker">Provider templates</span><h2 id="method-title" class="dialog-title">模板与查询方式</h2><p id="method-subtitle" class="dialog-subtitle"></p></div><button id="method-close" class="dialog-close" type="button" aria-label="关闭">×</button></header>
      <div class="method-body">
        <section class="template-config" aria-label="供应商模板">
          <div class="template-grid">
            <label class="template-field"><span class="template-label">余额额度模板</span><select id="balance-template" class="template-select"></select><span id="balance-template-description" class="template-description"></span></label>
            <label class="template-field"><span class="template-label">逐请求 Token / 扣费模板</span><select id="request-template" class="template-select"></select><span id="request-template-description" class="template-description"></span></label>
          </div>
          <div class="template-actions"><button id="template-reset" class="button small" type="button">恢复内置</button><button id="template-detect" class="button small" type="button">自动识别</button><button id="template-test" class="button small" type="button">测试所选</button><button id="template-save" class="button small primary" type="button">保存模板</button></div>
          <div id="template-result" class="template-result" role="status" hidden></div>
        </section>
        <dl id="method-fields" class="method-fields"></dl>
        <section id="method-notes" class="method-notes"><h3>实现说明</h3><ul id="method-note-list"></ul></section>
        <p class="method-warning">这里只显示请求结构，不显示 API Key、Cookie、Bearer Token、账号文件内容或其他认证原文。</p>
      </div>
    </div>
  </dialog>
  <dialog id="trust-dialog" class="method-dialog" aria-labelledby="trust-title">
    <div class="method-panel">
      <header class="dialog-head"><div><span class="dialog-kicker">Local privacy</span><h2 id="trust-title" class="dialog-title">隐私与安全</h2><p class="dialog-subtitle">所有状态与偏好保留在本机</p></div><button id="trust-close" class="dialog-close" type="button" aria-label="关闭">×</button></header>
      <div class="method-body">
        <ul class="trust-list">
          <li><strong>数据边界</strong><span>CCSwitch 数据库保持只读。API Key 与账户 Token 只在本机宿主内存中用于供应商请求，不进入 Hub 页面。</span></li>
          <li><strong>浏览器权限</strong><span>浏览器伴侣只申请当前模板需要的精确 HTTPS 站点权限；Cookie 原文始终保留在 Edge 或 Chrome 中。</span></li>
          <li><strong>本机留存</strong><span>runtime 目录只保存余额缓存、无凭据的界面偏好、模板绑定和随机 Hub 路径令牌。</span></li>
          <li><strong>外部通信</strong><span>除用户配置的供应商接口外，不上传用量、诊断或身份数据，也不包含遥测。</span></li>
          <li><strong>诊断报告</strong><span>复制的诊断报告不包含 API Key、Cookie、Bearer Token 或请求正文。</span></li>
        </ul>
      </div>
      <footer class="diagnostic-footer"><button id="trust-done" class="button primary" type="button">完成</button></footer>
    </div>
  </dialog>
  <div id="toast" class="toast" role="status"></div>
  <script nonce="${nonce}">
    const API=${safeApiBase};
    const grid=document.getElementById('provider-list');
    const refreshAll=document.getElementById('refresh-all');
    const copyCompanion=document.getElementById('copy-companion');
    const openDiagnosticsButton=document.getElementById('open-diagnostics');
    const searchInput=document.getElementById('provider-search');
    const sortSelect=document.getElementById('provider-sort');
    const viewButtons=[...document.querySelectorAll('[data-view]')];
    const providerSurface=document.getElementById('provider-surface');
    const browserTasks=document.getElementById('browser-tasks');
    const browserTaskCount=document.getElementById('browser-task-count');
    const browserTaskGroups=document.getElementById('browser-task-groups');
    const activation=document.getElementById('activation');
    const activationCodexDot=document.getElementById('activation-codex-dot');
    const activationCodexState=document.getElementById('activation-codex-state');
    const activationProviderDot=document.getElementById('activation-provider-dot');
    const activationProviderState=document.getElementById('activation-provider-state');
    const activationBrowserDot=document.getElementById('activation-browser-dot');
    const activationBrowserState=document.getElementById('activation-browser-state');
    const activationRefresh=document.getElementById('activation-refresh');
    const activationBrowser=document.getElementById('activation-browser');
    const activationComplete=document.getElementById('activation-complete');
    const sync=document.getElementById('sync');
    const toast=document.getElementById('toast');
    const diagnosticDialog=document.getElementById('diagnostic-dialog');
    const diagnosticSubtitle=document.getElementById('diagnostic-subtitle');
    const diagnosticSummary=document.getElementById('diagnostic-summary');
    const diagnosticChecks=document.getElementById('diagnostic-checks');
    const diagnosticProfiles=document.getElementById('diagnostic-profiles');
    const diagnosticIssues=document.getElementById('diagnostic-issues');
    const diagnosticOrigins=document.getElementById('diagnostic-origins');
    const trustDialog=document.getElementById('trust-dialog');
    const openTrustButton=document.getElementById('open-trust');
    const methodDialog=document.getElementById('method-dialog');
    const methodTitle=document.getElementById('method-title');
    const methodSubtitle=document.getElementById('method-subtitle');
    const methodFields=document.getElementById('method-fields');
    const methodNotes=document.getElementById('method-notes');
    const methodNoteList=document.getElementById('method-note-list');
    const balanceTemplate=document.getElementById('balance-template');
    const requestTemplate=document.getElementById('request-template');
    const balanceTemplateDescription=document.getElementById('balance-template-description');
    const requestTemplateDescription=document.getElementById('request-template-description');
    const templateResult=document.getElementById('template-result');
    const templateButtons=['template-reset','template-detect','template-test','template-save'].map(id=>document.getElementById(id));
    const number=new Intl.NumberFormat(undefined,{maximumFractionDigits:2});
    const loginLinkFor=${hubLoginLink.toString()};
    const browserForProvider=${resolveProviderBrowser.toString()};
    const taskKindFor=${browserTaskKind.toString()};
    const messageForProvider=${hubProviderMessage.toString()};
    const providerNeedsAttention=${hubProviderNeedsAttention.toString()};
    const authStorageKey='ccswitch-hub-auth-checks-v1';
    let state={providers:[],refreshing:false,preferences:{version:3,setupComplete:false,favorites:[],ignoredProviders:[],sort:'smart',view:'cards',browserAliases:{},providerBrowsers:{}},diagnostics:{},browserOrigins:[]};
    let filter='all';
    let query='';
    let renderKey='';
    let lastRenderedAt=0;
    let toastTimer=0;
    let operationMonitorTimer=0;
    let operationMonitorDeadline=0;
    let companionMonitorTimer=0;
    let methodItem=null;
    let templateCatalog=null;
    let diagnosticProviderId='';
    let authChecks=readAuthChecks();
    const authLaunches=new Map();
    const browserTaskBusy=new Set();
    let authCheckPromise=null;
    const sourceNames={official_api:'官方 API（API Key，无需官网登录）',provider_api:'供应商 API（API Key，无需官网登录）',api_key_probe:'API Key 能力检查（无需官网登录）',new_api_key:'New API Key 额度（无需官网登录）',new_api_account:'New API 账户总额度',new_api_browser:'New API 浏览器查询',jianzhile_api_key:'简直了 API Key 额度（无需官网登录）',jianzhile_account:'简直了账户总额度',freely_api_key:'freely API Key 额度（无需官网登录）',freely_account:'freely 账户总额度',muyuan_api_key:'君的公益 API Key 额度（无需官网登录）',muyuan_account:'君的公益账户总额度',muyuan_browser:'君的公益浏览器查询',muyuan_local_usage:'君的公益本地用量估算',welfare_api_key:'无名公益站 API Key 额度（无需官网登录）',welfare_account:'无名公益站账户总额度',openai_wham:'OpenAI 用量接口',openai_wham_browser:'OpenAI 用量接口（现有浏览器）',cpa_auth_files:'CLIProxyAPI 本地账号',browser_session:'现有浏览器会话',cached_previous:'上次缓存',api_health_and_local_usage:'API Key 健康检查（无需官网登录）+ 本地统计'};
    function showToast(message){toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2800)}
    function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node}
    function readAuthChecks(){const checks=new Map();try{const parsed=JSON.parse(sessionStorage.getItem(authStorageKey)||'{}');for(const [providerId,value] of Object.entries(parsed||{}).slice(0,32)){const phase=String(value?.phase||'');if(!providerId||providerId.length>160||!['waiting','checking','manual'].includes(phase))continue;checks.set(providerId,{providerId,clientRef:String(value?.clientRef||'').slice(0,64),browser:String(value?.browser||'').slice(0,24),phase,startedAt:Number(value?.startedAt)||Date.now(),leftAt:Number(value?.leftAt)||0,checkStartedAt:Number(value?.checkStartedAt)||0,baselineAttemptAt:String(value?.baselineAttemptAt||'')})}}catch{}return checks}
    function writeAuthChecks(){try{sessionStorage.setItem(authStorageKey,JSON.stringify(Object.fromEntries(authChecks)))}catch{}}
    function pendingAuth(item){return authChecks.get(String(item?.id||''))||null}
    function providerNeedsAuthCheck(item){return Boolean(item?.websiteLoginRequired||item?.sessionSyncRequired||String(item?.status||'')==='login-required')}
    function markHubLeft(){const now=Date.now();let changed=false;for(const launch of authLaunches.values()){if(!launch.leftAt)launch.leftAt=now}for(const entry of authChecks.values()){if(entry.phase==='waiting'&&!entry.leftAt){entry.leftAt=now;changed=true}}if(changed)writeAuthChecks()}
    function trackAuthResult(item,clientRef,browser,baselineAttemptAt,launch){const id=String(item?.id||'');if(!id)return;if(item.websiteLoginRequired===true){authChecks.set(id,{providerId:id,clientRef:String(clientRef||''),browser:String(browser||''),phase:'waiting',startedAt:Date.now(),leftAt:Number(launch?.leftAt)||((document.visibilityState==='hidden'||!document.hasFocus())?Date.now():0),checkStartedAt:0,baselineAttemptAt:String(baselineAttemptAt||'')});writeAuthChecks();render();setTimeout(maybeAutoCheckPending,0);return}if(!providerNeedsAuthCheck(item)&&authChecks.delete(id)){writeAuthChecks();render()}}
    function reconcileAuthChecks(next){const providers=new Map((next.providers||[]).map(item=>[String(item.id),item]));const now=Date.now();let changed=false;for(const [id,entry] of authChecks){const item=providers.get(id);if(!item||now-entry.startedAt>7200000){authChecks.delete(id);changed=true;continue}if(!providerNeedsAuthCheck(item)&&!item.refreshing){authChecks.delete(id);changed=true;continue}if(entry.phase==='checking'&&!item.refreshing){const attempted=String(item.lastAttemptAt||'')!==String(entry.baselineAttemptAt||'')||(!next.refreshing&&now-entry.checkStartedAt>=1200);if(attempted){entry.phase='manual';entry.checkStartedAt=0;entry.baselineAttemptAt=String(item.lastAttemptAt||'');changed=true}}}if(changed)writeAuthChecks();return changed}
    function format(value,unit=''){if(value==null||value==='')return '--';const numeric=Number(value);return Number.isFinite(numeric)?number.format(numeric)+(unit?' '+unit:''):'--'}
    function age(value){const time=Date.parse(value||'');if(!Number.isFinite(time))return '尚未更新';const minutes=Math.max(0,Math.floor((Date.now()-time)/60000));if(minutes<1)return '刚刚更新';if(minutes<60)return minutes+' 分钟前';if(minutes<1440)return Math.floor(minutes/60)+' 小时前';return Math.floor(minutes/1440)+' 天前'}
    function statusMeta(item){if(providerIsIgnored(item))return ['已忽略',''];const pending=pendingAuth(item);if(pending?.phase==='waiting')return ['等待认证','warning'];if(pending?.phase==='checking')return ['正在验证','loading'];if(pending?.phase==='manual')return ['待重新检查','warning'];if(item.refreshing||item.status==='loading')return ['查询中','loading'];if(item.accountBindingRequired)return ['需要绑定','warning'];if(item.websiteLoginRequired)return ['需要官网认证','warning'];if(item.sessionSyncRequired)return ['需要同步','warning'];if(item.status==='ok')return ['正常','ok'];if(item.status==='degraded')return ['仅部分可用','warning'];if(item.status==='login-required')return [item.sessionSyncSupported?'需要同步':'需要登录','warning'];if(item.status==='idle')return ['等待查询',''];return ['查询失败','error']}
    function sourceLabel(item){if(sourceNames[item.source])return sourceNames[item.source];if(item.source)return item.source;const type=item.queryMethod?.type;if(type==='api-key')return 'API Key 直查（无需官网登录）';if(type==='api-health')return 'API Key 健康检查（无需官网登录）';if(type==='api-key-with-account-fallback')return 'API Key / 官网账户模式';if(type==='browser-cookie')return '浏览器账户模式';if(type==='openai-account')return 'OpenAI 账户模式';if(type==='local-accounts')return '本机账号模式';return '未选择查询方式'}
    function providerNeedsBrowser(item){const method=item.queryMethod||{};return method.requiresBrowser===true||method.waf===true||method.type==='api-key-with-account-fallback'||item.accountBindingSupported===true}
    function favorites(){return new Set(state.preferences?.favorites||[])}
    function ignoredProviderIds(){return new Set(state.preferences?.ignoredProviders||[])}
    function providerIsIgnored(item){return Boolean(!item?.current&&ignoredProviderIds().has(String(item?.id||'')))}
    function activeProviders(providers=state.providers||[]){return(providers||[]).filter(item=>!providerIsIgnored(item))}
    function setActivationState(dot,label,text,tone=''){dot.className='activation-dot'+(tone?' '+tone:'');label.textContent=text}
    function renderActivation(providers){activation.hidden=state.preferences?.setupComplete===true;if(activation.hidden)return;const current=(providers||[]).find(item=>item.current);const diagnostics=state.diagnostics||{};const codexReady=Number(diagnostics.connectedPages)>0&&!diagnostics.connectionError;const currentReady=Boolean(current?.usage&&['ok','degraded'].includes(String(current.status||'')));const browserNeeded=(providers||[]).some(providerNeedsBrowser);const browserReady=!browserNeeded||(state.companion?.clients||[]).length>0;setActivationState(activationCodexDot,activationCodexState,codexReady?'已连接':diagnostics.connectionError?'连接异常':'未连接',codexReady?'ok':'error');setActivationState(activationProviderDot,activationProviderState,!current?'未找到':currentReady?'数据已就绪':current.refreshing?'查询中':'待查询',currentReady?'ok':current?'warning':'error');setActivationState(activationBrowserDot,activationBrowserState,!browserNeeded?'当前无需':browserReady?'已连接':'按需连接',browserReady?'ok':'warning');activationRefresh.hidden=currentReady;activationRefresh.disabled=!current||Boolean(current?.refreshing);activationRefresh.textContent=current?.refreshing?'查询中':'查询当前供应商';activationBrowser.hidden=!browserNeeded||browserReady;activationComplete.disabled=!codexReady||!current}
    function requestHost(item){try{return new URL(String(item.queryMethod?.requestUrl||'')).hostname}catch{return ''}}
    function stateRenderKey(next){const companion=next.companion||{connected:false,clients:[]};const clients=(companion.clients||[]).map(client=>[client.ref,client.browser,client.version,[...(client.sessions||[])].sort()]);return JSON.stringify([next.revision,next.refreshing,next.lastFullRefreshAt,companion.connected,companion.compatibilityError||'',clients,next.preferences||{},next.diagnostics||{},next.browserOrigins||[]])}
    function action(label,handler,primary=false){const button=el('button','button small'+(primary?' primary':''),label);button.type='button';button.addEventListener('click',handler);return button}
    function linkAction(label,href,primary=false){const link=el('a','button small'+(primary?' primary':''),label);link.href=href;link.target='_blank';link.rel='noreferrer';return link}
    function companionTargets(){const clients=(state.companion?.clients||[]).filter(client=>client?.ref&&client?.browser).slice().sort((left,right)=>String(left.browser).localeCompare(String(right.browser)));const totals={};for(const client of clients)totals[client.browser]=(totals[client.browser]||0)+1;const seen={};const aliases=state.preferences?.browserAliases||{};return clients.map(client=>{seen[client.browser]=(seen[client.browser]||0)+1;const fallback=client.browser+(totals[client.browser]>1?' '+seen[client.browser]:'');return{ref:client.ref,browser:client.browser,label:aliases[client.ref]||fallback,sessions:Array.isArray(client.sessions)?client.sessions:[],version:client.version,lastSeenAt:client.lastSeenAt}})}
    function providerBrowserInfo(item){return browserForProvider(item,companionTargets(),state.preferences||{})}
    function browserStatusMeta(item){const info=providerBrowserInfo(item);if(info.state==='known'){const reasons={binding:'账号已绑定到 '+info.label,preference:'你上次为此供应商选择了 '+info.label,result:'上次成功查询使用 '+info.label,session:'该官网会话已在 '+info.label+' 验证',only:'当前仅连接了 '+info.label};return['浏览器：'+info.label,'known',reasons[info.reason]||('当前使用 '+info.label)]}if(info.state==='offline')return['浏览器：'+info.label+'（离线）','offline','之前使用的浏览器当前未连接'];if(info.state==='ambiguous')return['浏览器：未指定','choice','多个浏览器都有该官网会话，请选择本供应商使用哪一个'];if(info.state==='unassigned')return['浏览器：未指定','choice','请从更多操作中选择 Chrome 或 Edge'];return['浏览器：未连接','offline','请先连接 Edge 或 Chrome 的余额伴侣']}
    function companionSummary(clients){const counts={};for(const client of clients||[]){const browser=String(client?.browser||'').trim();if(browser)counts[browser]=(counts[browser]||0)+1}return Object.keys(counts).sort().map(browser=>browser+(counts[browser]>1?'（'+counts[browser]+' 个）':'')+' 已连接').join(' · ')}
    async function post(route,body={}){const response=await fetch(API+'/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.message||'本机 Hub 请求失败');return payload}
    async function refreshProviders(ids,{trackAuth=false,quiet=false}={}){const unique=[...new Set((ids||[]).map(String).filter(Boolean))];if(!unique.length)return[];const now=Date.now();if(trackAuth){for(const id of unique){const entry=authChecks.get(id);if(!entry)continue;const item=(state.providers||[]).find(provider=>String(provider.id)===id);entry.phase='checking';entry.checkStartedAt=now;entry.baselineAttemptAt=String(item?.lastAttemptAt||'')}writeAuthChecks();render()}const results=await Promise.allSettled(unique.map(providerId=>post('refresh',{providerId})));for(let index=0;index<results.length;index+=1){if(results[index].status==='fulfilled')continue;const entry=authChecks.get(unique[index]);if(entry){entry.phase='manual';entry.checkStartedAt=0}}writeAuthChecks();scheduleOperationMonitor();await load();if(!quiet){const failed=results.filter(result=>result.status==='rejected').length;showToast(failed?('已启动 '+(unique.length-failed)+' 项检查，'+failed+' 项未能启动'):unique.length===1?'已开始重新查询':'已开始重新检查 '+unique.length+' 个供应商')}return results}
    function maybeAutoCheckPending(){if(authCheckPromise||document.visibilityState==='hidden'||!document.hasFocus())return;const ids=[...authChecks.values()].filter(entry=>entry.phase==='waiting'&&entry.leftAt>0).map(entry=>entry.providerId);if(!ids.length)return;showToast(ids.length===1?'已返回 Hub，正在自动检查认证':'已返回 Hub，正在自动检查 '+ids.length+' 项认证');authCheckPromise=refreshProviders(ids,{trackAuth:true,quiet:true}).finally(()=>{authCheckPromise=null})}
    async function refreshOne(id){await refreshProviders([id],{trackAuth:authChecks.has(String(id))})}
    function providerRefreshAction(item){const button=action(item.refreshing?'查询中':'刷新',()=>refreshOne(item.id));button.disabled=Boolean(item.refreshing);return button}
    async function rememberProviderBrowser(id,clientRef,browser){if(!id||!clientRef||!browser)return;const result=await post('preferences',{providerBrowser:{providerId:id,clientRef,browser}});state={...state,preferences:result.preferences};renderKey=''}
    async function requestLogin(id,clientRef='',browser=''){const current=(state.providers||[]).find(item=>String(item.id)===String(id));const launch={leftAt:0};authLaunches.set(String(id),launch);try{const result=await post('login',{providerId:id,clientRef});let saved=true;if(clientRef&&browser){try{await rememberProviderBrowser(id,clientRef,browser)}catch{saved=false}}trackAuthResult(result.provider,clientRef,browser,current?.lastAttemptAt,launch);return{result,saved}}finally{authLaunches.delete(String(id))}}
    async function login(id,clientRef='',browser=''){try{const outcome=await requestLogin(id,clientRef,browser);const item=outcome.result.provider;const message=item?.message||(item?.status==='ok'?'同步成功':browser?'已发送到 '+browser:'操作已完成');showToast(message+(outcome.saved?'':'；浏览器选择未保存'));if(item?.refreshing)scheduleOperationMonitor()}catch(error){showToast(error.message)}await load()}
    async function requestBinding(id,clientRef,browser){const result=await post('account-binding',{providerId:id,clientRef});let saved=true;if(!result.provider?.bindingAttemptFailed){try{await rememberProviderBrowser(id,clientRef,browser)}catch{saved=false}}return{result,saved}}
    async function bindAccount(id,clientRef,browser){try{const outcome=await requestBinding(id,clientRef,browser);showToast((outcome.result.provider?.bindingAttemptFailed?outcome.result.provider.message:'已绑定 '+browser+' AnyRouter 账号并完成刷新')+(outcome.saved?'':'；浏览器选择未保存'));scheduleOperationMonitor()}catch(error){showToast(error.message)}await load()}
    async function clearAccountBinding(id){try{await post('account-binding',{providerId:id,action:'clear'});showToast('已解除 AnyRouter 浏览器账号绑定')}catch(error){showToast(error.message)}await load()}
    async function copyCompanionToken(){const token=API.split('/').filter(Boolean).at(-1)||'';try{await navigator.clipboard.writeText(token);showToast(state.companion?.connected?'浏览器已连接，无需重复配置；连接码也已复制':'浏览器伴侣连接码已复制')}catch{showToast(state.companion?.connected?'浏览器伴侣当前已连接，无需重复配置':'复制失败，请从本机 runtime/hub-token 读取连接码')}}
    async function toggleFavorite(id){const current=favorites();const enabled=!current.has(id);if(enabled)current.add(id);else current.delete(id);const previous=state.preferences;state={...state,preferences:{...previous,favorites:[...current]}};render();try{const result=await post('preferences',{favorite:{providerId:id,enabled}});state={...state,preferences:result.preferences};renderKey='';render()}catch(error){state={...state,preferences:previous};render();showToast(error.message)}}
    async function toggleIgnored(id){const item=(state.providers||[]).find(provider=>String(provider.id)===String(id));if(item?.current){showToast('当前供应商不能忽略');return}const current=ignoredProviderIds();const ignored=!current.has(String(id));if(ignored)current.add(String(id));else current.delete(String(id));const previous=state.preferences;state={...state,preferences:{...previous,ignoredProviders:[...current]}};render();try{const result=await post('preferences',{ignoredProvider:{providerId:id,ignored}});state={...state,preferences:result.preferences};renderKey='';render();showToast(ignored?'已从工作区忽略，可在“已忽略”中恢复':'已恢复到工作区')}catch(error){state={...state,preferences:previous};render();showToast(error.message)}}
    async function completeSetup(){const previous=state.preferences;state={...state,preferences:{...previous,setupComplete:true}};render();try{const result=await post('preferences',{setupComplete:true});state={...state,preferences:result.preferences};renderKey='';render();showToast('首次检查已完成')}catch(error){state={...state,preferences:previous};render();showToast(error.message)}}
    async function saveSort(value){try{const result=await post('preferences',{sort:value});state={...state,preferences:result.preferences};renderKey='';render()}catch(error){showToast(error.message)}}
    async function saveView(value){if(!['cards','compact'].includes(value))return;const previous=state.preferences;state={...state,preferences:{...previous,view:value}};render();try{const result=await post('preferences',{view:value});state={...state,preferences:result.preferences};renderKey='';render()}catch(error){state={...state,preferences:previous};render();showToast(error.message)}}
    async function saveBrowserAlias(clientRef,label){try{const result=await post('preferences',{browserAlias:{clientRef,label}});state={...state,preferences:result.preferences};renderKey='';render();showToast(label.trim()?'浏览器名称已保存':'已恢复默认浏览器名称')}catch(error){showToast(error.message)}}
    function quotaRatio(item){const remaining=Number(item.usage?.remaining);const total=Number(item.usage?.total);return Number.isFinite(remaining)&&Number.isFinite(total)&&total>0?Math.max(0,Math.min(1,remaining/total)):null}
    function orderedProviders(providers){const favoriteIds=favorites();const sort=state.preferences?.sort||'smart';return providers.slice().sort((left,right)=>{if(sort==='name')return String(left.name).localeCompare(String(right.name),'zh-CN');if(sort==='remaining'){const a=quotaRatio(left);const b=quotaRatio(right);if(a==null&&b!=null)return 1;if(a!=null&&b==null)return -1;if(a!==b)return a-b}if(sort==='updated'){const a=Date.parse(left.usage?.updatedAt||left.lastSuccessAt||'')||0;const b=Date.parse(right.usage?.updatedAt||right.lastSuccessAt||'')||0;if(a!==b)return b-a}if(sort==='latency'){const a=Number.isFinite(Number(left.queryDurationMs))?Number(left.queryDurationMs):Infinity;const b=Number.isFinite(Number(right.queryDurationMs))?Number(right.queryDurationMs):Infinity;if(a!==b)return a-b}if(sort==='smart'){const rank=item=>item.current?0:providerNeedsAttention(item)?1:favoriteIds.has(item.id)?2:3;const a=rank(left);const b=rank(right);if(a!==b)return a-b}return String(left.name).localeCompare(String(right.name),'zh-CN')})}
    function filteredProviders(providers){const favoriteIds=favorites();const needle=query.trim().toLocaleLowerCase('zh-CN');let shown=filter==='ignored'?(providers||[]).filter(providerIsIgnored):activeProviders(providers);if(filter==='favorites')shown=shown.filter(item=>favoriteIds.has(item.id));if(filter==='attention')shown=shown.filter(providerNeedsAttention);if(filter==='ok')shown=shown.filter(item=>item.status==='ok'&&!providerNeedsAttention(item));if(filter==='browser')shown=shown.filter(providerNeedsBrowser);if(needle)shown=shown.filter(item=>[item.name,messageForProvider(item),requestHost(item),sourceLabel(item),statusMeta(item)[0],providerNeedsBrowser(item)?providerBrowserInfo(item).label:''].some(value=>String(value||'').toLocaleLowerCase('zh-CN').includes(needle)));return orderedProviders(shown)}
    function openDiagnostics(providerId=''){diagnosticProviderId=String(providerId||'');renderDiagnostics();if(typeof diagnosticDialog.showModal==='function'){if(!diagnosticDialog.open)diagnosticDialog.showModal()}else{diagnosticDialog.setAttribute('open','')}if(diagnosticProviderId)setTimeout(()=>diagnosticIssues.querySelector('.highlight')?.scrollIntoView({block:'center'}),0)}
    function openTrust(){if(typeof trustDialog.showModal==='function'){if(!trustDialog.open)trustDialog.showModal()}else{trustDialog.setAttribute('open','')}}
    function revealProvider(providerId){diagnosticDialog.close();diagnosticProviderId='';filter='all';query='';searchInput.value='';document.querySelectorAll('.tab').forEach(tab=>{const active=tab.dataset.filter==='all';tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});render();const row=[...grid.children].find(node=>node.dataset?.providerId===providerId);const detail=row?.querySelector('.provider-detail');const more=row?.querySelector('[aria-label="更多操作"]');if(detail){detail.hidden=false;more?.setAttribute('aria-expanded','true');row.scrollIntoView({block:'center'})}}
    function primaryProviderAction(item){if(providerIsIgnored(item))return action('恢复',()=>toggleIgnored(item.id),true);const pending=pendingAuth(item);if(pending?.phase==='waiting'||pending?.phase==='checking'){const button=action(pending.phase==='waiting'?'等待认证完成':'正在自动检查',()=>{},true);button.disabled=true;return button}if(pending?.phase==='manual')return action('我已完成认证，重新检查',()=>refreshOne(item.id),true);const targets=companionTargets();const connected=targets.length>0;const loginInfo=loginLinkFor(item);const browserInfo=providerBrowserInfo(item);const target=browserInfo.target;if(item.accountBindingRequired){if(target)return action('绑定 '+target.label,()=>bindAccount(item.id,target.ref,target.browser),true);return action(connected?'选择浏览器':'连接浏览器',()=>connected?revealProvider(item.id):copyCompanionToken(),true)}if(item.sessionSyncRequired){if(target)return action('同步 '+target.label,()=>login(item.id,target.ref,target.browser),true);return action(connected?'选择浏览器':'连接浏览器',()=>connected?revealProvider(item.id):copyCompanionToken(),true)}if(item.websiteLoginRequired&&loginInfo){if(target)return action('在 '+target.label+' 认证',()=>login(item.id,target.ref,target.browser),true);if(connected)return action('选择浏览器',()=>revealProvider(item.id),true);return linkAction('重新登录',loginInfo.href,true)}const button=providerNeedsAttention(item)?action(item.refreshing?'查询中':'重试',()=>refreshOne(item.id),true):action(item.refreshing?'查询中':'刷新',()=>refreshOne(item.id));button.disabled=Boolean(item.refreshing);return button}
    function providerSecondaryActions(item){const actions=el('div','detail-actions');if(providerIsIgnored(item)){actions.append(action('恢复到工作区',()=>toggleIgnored(item.id),true));return actions}actions.append(action('模板',()=>showQueryMethod(item)));const loginInfo=loginLinkFor(item);const targets=companionTargets();const companionConnected=targets.length>0;const browserInfo=providerBrowserInfo(item);if(item.accountBindingSupported&&companionConnected){const binding=item.accountBinding;let boundTargetShown=false;for(const target of targets){const hasSession=target.sessions.includes('https://anyrouter.top');const selected=binding?.clientRef===target.ref;if(selected){boundTargetShown=true;actions.append(el('span','binding-current','已绑定 '+target.label));if(!hasSession)actions.append(action('在 '+target.label+' 验证',()=>login(item.id,target.ref,target.browser),true));continue}const bindLabel=binding?'改绑 '+target.label:'绑定 '+target.label;if(hasSession)actions.append(action(bindLabel,()=>bindAccount(item.id,target.ref,target.browser),!binding));else actions.append(action('在 '+target.label+' 验证',()=>login(item.id,target.ref,target.browser)))}if(binding&&!boundTargetShown){const offlineLabel=state.preferences?.browserAliases?.[binding.clientRef]||binding.browser;actions.append(el('span','binding-current','已绑定 '+offlineLabel+'（离线）'))}if(binding)actions.append(action('解除绑定',()=>clearAccountBinding(item.id)))}else if(loginInfo){if(companionConnected){const verb=loginInfo.primary?'验证':'登录';const ordered=targets.slice().sort((left,right)=>Number(right.ref===browserInfo.clientRef)-Number(left.ref===browserInfo.clientRef));for(const target of ordered){const selected=target.ref===browserInfo.clientRef;const label=selected?'在 '+target.label+' '+verb:browserInfo.clientRef?'改用 '+target.label:'在 '+target.label+' '+verb;actions.append(action(label,()=>login(item.id,target.ref,target.browser),loginInfo.primary&&selected))}}else actions.append(linkAction(loginInfo.label,loginInfo.href,loginInfo.primary))}else if(item.websiteUrl)actions.append(linkAction('官网',item.websiteUrl));if(item.sessionSyncRequired&&!companionConnected)actions.append(action('同步现有会话',()=>login(item.id),true));actions.append(providerRefreshAction(item));if(!item.current)actions.append(action('忽略',()=>toggleIgnored(item.id)));return actions}
    function browserTaskGroupsFor(providers){const groups=new Map();for(const item of providers||[]){const pending=pendingAuth(item);let kind=pending?.phase||taskKindFor(item);if(pending?.phase==='manual')kind='check';if(!kind)continue;const info=providerBrowserInfo(item);const key=info.clientRef?'client:'+info.clientRef:info.state==='disconnected'?'disconnected':info.state==='offline'?'offline:'+(info.browser||info.label):'unassigned';if(!groups.has(key))groups.set(key,{key,target:info.target,info,tasks:[]});groups.get(key).tasks.push({item,kind})}return[...groups.values()].sort((left,right)=>{if(Boolean(left.target)!==Boolean(right.target))return left.target?-1:1;return String(left.info.label||'').localeCompare(String(right.info.label||''),'zh-CN')})}
    function browserTaskLabel(kind){return{binding:'待绑定',sync:'待同步',authentication:'待认证',waiting:'等待认证',checking:'正在验证',check:'待重检'}[kind]||'待处理'}
    async function runBrowserTaskGroup(group){if(browserTaskBusy.has(group.key))return;if(!group.target){if(group.info.state==='disconnected'||group.info.state==='offline')await copyCompanionToken();else revealProvider(group.tasks[0]?.item.id);return}browserTaskBusy.add(group.key);render();let succeeded=0;let failed=0;let opened=0;const checks=[];try{for(const task of group.tasks){if(task.kind==='waiting'||task.kind==='checking')continue;if(task.kind==='check'){checks.push(task.item.id);continue}try{if(task.kind==='binding'){const outcome=await requestBinding(task.item.id,group.target.ref,group.target.browser);if(outcome.result.provider?.bindingAttemptFailed)failed+=1;else succeeded+=1}else{const outcome=await requestLogin(task.item.id,group.target.ref,group.target.browser);succeeded+=1;if(outcome.result.provider?.websiteLoginRequired)opened+=1}}catch{failed+=1}}if(checks.length){const results=await refreshProviders(checks,{trackAuth:true,quiet:true});succeeded+=results.filter(result=>result.status==='fulfilled').length;failed+=results.filter(result=>result.status==='rejected').length}scheduleOperationMonitor();await load();showToast((succeeded?'已处理 '+succeeded+' 项':'没有可处理的项目')+(opened?'；完成认证后返回 Hub 自动检查':'')+(failed?'；'+failed+' 项失败':''))}finally{browserTaskBusy.delete(group.key);render()}}
    async function refreshBrowserTaskGroup(group){if(browserTaskBusy.has(group.key))return;browserTaskBusy.add(group.key);render();try{const results=await refreshProviders(group.tasks.map(task=>task.item.id),{trackAuth:true,quiet:true});const failed=results.filter(result=>result.status==='rejected').length;showToast(failed?('已启动 '+(results.length-failed)+' 项检查，'+failed+' 项失败'):'已重新检查 '+results.length+' 个供应商')}finally{browserTaskBusy.delete(group.key);render()}}
    function renderBrowserTasks(providers){const groups=browserTaskGroupsFor(providers);const total=groups.reduce((sum,group)=>sum+group.tasks.length,0);browserTasks.hidden=total===0;browserTaskCount.textContent=total?total+' 项':'';browserTaskGroups.replaceChildren(...groups.map(group=>{const row=el('div','task-group');const browser=el('div','task-browser');const connected=Boolean(group.target);browser.append(el('span','task-browser-name',group.info.label||'未指定浏览器'),el('span','task-browser-meta',(connected?group.target.browser:group.info.state==='offline'?'浏览器当前离线':group.info.state==='disconnected'?'浏览器伴侣未连接':'需要逐项选择')+' · '+group.tasks.length+' 项'));const items=el('div','task-items');for(const task of group.tasks){const item=el('span','task-item');item.append(el('strong','',task.item.name),el('span','task-item-status',' · '+browserTaskLabel(task.kind)));items.append(item)}const actions=el('div','task-actions');const busy=browserTaskBusy.has(group.key);const actionable=group.tasks.some(task=>!['waiting','checking'].includes(task.kind));const process=action(busy?'处理中':connected?'处理全部':group.info.state==='unassigned'||group.info.state==='ambiguous'?'逐项选择':'连接浏览器',()=>runBrowserTaskGroup(group),connected);process.disabled=busy||!actionable;const refresh=action('重新检查全部',()=>refreshBrowserTaskGroup(group));refresh.disabled=busy;actions.append(process,refresh);row.append(browser,items,actions);return row}))}
    function renderProviderRow(item){const favoriteIds=favorites();const ignored=providerIsIgnored(item);const row=el('article','provider-row'+(item.current?' current':'')+(ignored?' ignored':'')+(!ignored&&providerNeedsAttention(item)?' attention':''));row.dataset.providerId=item.id;const main=el('div','provider-main');const star=el('button','icon-button favorite'+(favoriteIds.has(item.id)?' active':''),favoriteIds.has(item.id)?'★':'☆');star.type='button';star.title=favoriteIds.has(item.id)?'取消收藏':'收藏';star.setAttribute('aria-label',star.title);star.setAttribute('aria-pressed',String(favoriteIds.has(item.id)));star.addEventListener('click',()=>toggleFavorite(item.id));main.append(star);const identity=el('div','provider-cell');const identityLine=el('div','provider-identity');identityLine.append(el('strong','provider-name',item.name));if(item.current)identityLine.append(el('span','current-label','CCSwitch 当前'));identity.append(identityLine,el('div','provider-meta',requestHost(item)||item.queryMethod?.label||'未识别域名'),el('div','provider-message',messageForProvider(item)||'等待第一次查询'));main.append(identity);const status=el('div','provider-cell cell-status');const meta=statusMeta(item);status.append(el('span','badge '+meta[1],meta[0]));if(providerNeedsBrowser(item)&&!ignored){const browserMeta=browserStatusMeta(item);const browserStatus=el('span','browser-status '+browserMeta[1],browserMeta[0]);browserStatus.title=browserMeta[2];status.append(browserStatus)}main.append(status);const usage=item.usage;const quota=el('div','provider-cell cell-quota');const compactQuota=el('div','compact-quota');compactQuota.append(el('div','quota-primary remaining',format(usage?.remaining,usage?.unit)),el('div','cell-secondary','已用 '+format(usage?.used,usage?.unit)+' · 总额 '+format(usage?.total,usage?.unit)));const cardMetrics=el('div','card-metrics');for(const [label,value,className] of [['已用',usage?.used,''],['剩余',usage?.remaining,'remaining'],['总额',usage?.total,'']]){const metric=el('div','card-metric');metric.append(el('span','card-metric-label',label),el('strong','card-metric-value'+(className?' '+className:''),format(value,usage?.unit)));cardMetrics.append(metric)}quota.append(compactQuota,cardMetrics);const ratio=quotaRatio(item);const progress=el('div','progress');const fill=el('i');fill.style.width=(ratio==null?0:ratio*100)+'%';progress.append(fill);quota.append(progress);main.append(quota);const balanceUpdatedAt=usage?.updatedAt||item.lastSuccessAt||item.updatedAt;const source=el('div','provider-cell cell-source');source.append(el('div','source-line',sourceLabel(item)),el('div','cell-secondary',age(balanceUpdatedAt)));main.append(source);const latency=el('div','provider-cell cell-latency');latency.append(el('div','latency',Number.isFinite(Number(item.queryDurationMs))?number.format(Number(item.queryDurationMs))+' ms':'--'),el('div','cell-secondary',item.lastAttemptAt?'最近尝试 '+age(item.lastAttemptAt):''));main.append(latency);const rowActions=el('div','row-actions');rowActions.append(primaryProviderAction(item));if(!ignored&&(item.accountBindingRequired||item.sessionSyncRequired||item.websiteLoginRequired))rowActions.append(providerRefreshAction(item));const more=el('button','icon-button','⋯');more.type='button';more.title='更多操作';more.setAttribute('aria-label','更多操作');more.setAttribute('aria-expanded','false');rowActions.append(more);main.append(rowActions);const detail=el('div','provider-detail');detail.hidden=true;detail.append(el('div','detail-copy',messageForProvider(item,true)||sourceLabel(item)),providerSecondaryActions(item));more.addEventListener('click',()=>{detail.hidden=!detail.hidden;more.setAttribute('aria-expanded',String(!detail.hidden))});row.append(main,detail);return row}
    function diagnosticCheckItems(){const allProviders=state.providers||[];const providers=activeProviders(allProviders);const ignoredCount=allProviders.length-providers.length;const d=state.diagnostics||{};const companion=state.companion||{connected:false,clients:[]};const browserCount=providers.filter(providerNeedsBrowser).length;const attentionCount=providers.filter(providerNeedsAttention).length;const versions=(companion.clients||[]).map(client=>String(client.version||'')).filter(Boolean);const expected=String(d.expectedCompanionVersion||'');const versionOk=!versions.length||!expected||versions.every(value=>value===expected);return[
      {tone:d.hubRunning&&d.hubPort?'ok':'error',title:'Balance Hub 宿主',detail:(d.appVersion?'v'+d.appVersion+' · ':'')+(d.hubRunning?'127.0.0.1:'+d.hubPort:'服务未监听')},
      {tone:d.connectedPages>0&&!d.connectionError?'ok':'error',title:'Codex 页面连接',detail:d.connectionError||((d.connectedPages||0)+' 个主页面 · CDP '+(d.cdpPort||'--'))},
      {tone:allProviders.length>0&&d.databaseWatch?'ok':allProviders.length>0?'warning':'error',title:'CCSwitch 数据源',detail:providers.length+' 个使用中供应商'+(ignoredCount?' · '+ignoredCount+' 个已忽略':'')+(d.databaseWatch?' · 变更监听正常':' · 变更监听未就绪')},
      {tone:browserCount===0?'neutral':companion.compatibilityError?'error':companion.connected?'ok':'warning',title:'浏览器伴侣',detail:browserCount===0?'当前供应商无需浏览器':companion.compatibilityError||companionSummary(companion.clients)||browserCount+' 个供应商可能需要连接浏览器',action:browserCount>0&&!companion.connected?'connect':''},
      {tone:versionOk?'ok':'warning',title:'伴侣版本',detail:versions.length?('当前 '+[...new Set(versions)].join(' / ')+(expected?' · 工作区 '+expected:'')):(expected?'工作区 '+expected+' · 尚未连接':'尚未报告版本')},
      {tone:attentionCount?'warning':'ok',title:'供应商状态',detail:attentionCount?attentionCount+' 个供应商需要处理':'当前没有待处理供应商'},
    ]}
    function diagnosticIssueCount(){const checks=diagnosticCheckItems().filter(item=>item.tone==='error').length;return checks+activeProviders().filter(providerNeedsAttention).length}
    function renderDiagnostics(){const checks=diagnosticCheckItems();const issues=activeProviders().filter(providerNeedsAttention);const problemCount=diagnosticIssueCount();diagnosticSubtitle.textContent=(state.diagnostics?.appVersion?'宿主 v'+state.diagnostics.appVersion+' · ':'')+(problemCount?problemCount+' 项需要关注':'运行状态正常');diagnosticSummary.replaceChildren(el('span','',problemCount?'优先处理红色和黄色状态':'所有核心检查均正常'));diagnosticSummary.append(action('复制连接码',copyCompanionToken));diagnosticChecks.replaceChildren(...checks.map(check=>{const row=el('div','check-row');row.append(el('span','check-dot '+check.tone));const copy=el('div');copy.append(el('div','check-title',check.title),el('div','check-detail',check.detail));row.append(copy);if(check.action==='connect')row.append(action('连接',copyCompanionToken));else row.append(el('span'));return row}));const targets=companionTargets();diagnosticProfiles.replaceChildren(...(targets.length?targets.map(target=>{const row=el('div','profile-row');const info=el('div');info.append(el('div','profile-name',target.label),el('div','profile-meta',target.browser+' · v'+(target.version||'未知')+' · '+target.sessions.length+' 个已验证会话'));const input=el('input','alias-input');input.type='text';input.maxLength=40;input.value=state.preferences?.browserAliases?.[target.ref]||'';input.placeholder='浏览器别名';const save=action('保存',()=>saveBrowserAlias(target.ref,input.value));input.addEventListener('keydown',event=>{if(event.key==='Enter')save.click()});row.append(info,input,save);return row}):[el('div','check-detail','浏览器伴侣尚未连接')]));diagnosticIssues.replaceChildren(...(issues.length?issues.map(item=>{const row=el('div','issue-row'+(diagnosticProviderId===item.id?' highlight':''));const copy=el('div');copy.append(el('div','issue-title',item.name+' · '+statusMeta(item)[0]),el('div','issue-detail',messageForProvider(item)||'等待处理'));row.append(copy,primaryProviderAction(item));return row}):[el('div','check-detail','当前没有需要处理的供应商')]));const clients=state.companion?.clients||[];diagnosticOrigins.replaceChildren(...((state.browserOrigins||[]).length?(state.browserOrigins||[]).map(origin=>{const verified=clients.some(client=>(client.sessions||[]).includes(origin));const row=el('div','origin-row');row.append(el('span','origin-name',origin),el('span','origin-state'+(verified?' ok':''),verified?'会话已验证':clients.length?'待首次验证':'伴侣未连接'));return row}):[el('div','check-detail','当前模板没有需要浏览器访问的站点')]))}
    async function copyDiagnosticReport(){const payload={generatedAt:new Date().toISOString(),application:state.diagnostics||{},companion:{connected:state.companion?.connected===true,compatibilityError:state.companion?.compatibilityError||'',clients:companionTargets().map(client=>({label:client.label,browser:client.browser,version:client.version,sessions:client.sessions,lastSeenAt:client.lastSeenAt}))},browserOrigins:state.browserOrigins||[],providers:(state.providers||[]).map(item=>({id:item.id,name:item.name,current:item.current===true,ignored:providerIsIgnored(item),status:item.status,attention:!providerIsIgnored(item)&&providerNeedsAttention(item),source:item.source||'',lastSuccessAt:item.lastSuccessAt||'',lastAttemptAt:item.lastAttemptAt||'',queryDurationMs:item.queryDurationMs,message:item.message||'',requiresBrowser:providerNeedsBrowser(item)}))};try{await navigator.clipboard.writeText(JSON.stringify(payload,null,2));showToast('脱敏诊断报告已复制')}catch{showToast('复制诊断报告失败')}}
    function render(){lastRenderedAt=Date.now();const providers=state.providers||[];const active=activeProviders(providers);renderActivation(active);const ignored=providers.filter(providerIsIgnored);const favoriteIds=favorites();const favoriteCount=active.filter(item=>favoriteIds.has(item.id)).length;const attention=active.filter(providerNeedsAttention);const browserProviders=active.filter(providerNeedsBrowser);const ok=active.filter(item=>item.status==='ok'&&!providerNeedsAttention(item));document.getElementById('count-all').textContent=active.length;document.getElementById('count-ok').textContent=ok.length;document.getElementById('count-attention').textContent=attention.length;document.getElementById('count-browser').textContent=(state.companion?.clients||[]).length;for(const [name,value] of Object.entries({all:active.length,favorites:favoriteCount,attention:attention.length,ok:ok.length,browser:browserProviders.length,ignored:ignored.length})){const target=document.querySelector('[data-count="'+name+'"]');if(target)target.textContent=value?String(value):''}const version=state.diagnostics?.appVersion;document.getElementById('app-version').textContent=version?'v'+version:'v2';refreshAll.disabled=Boolean(state.refreshing)||active.length===0;refreshAll.textContent=state.refreshing?'正在刷新…':'刷新全部';copyCompanion.textContent=state.companion?.connected?'浏览器已连接':'连接浏览器';const problems=diagnosticIssueCount();document.getElementById('diagnostic-count').textContent=problems?String(problems):'';sortSelect.value=state.preferences?.sort||'smart';const view=state.preferences?.view==='compact'?'compact':'cards';providerSurface.className='provider-list '+view;for(const button of viewButtons){const selected=button.dataset.view===view;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected))}renderBrowserTasks(active);const shown=filteredProviders(providers);const available=filter==='ignored'?ignored.length:active.length;document.getElementById('result-count').textContent='显示 '+shown.length+' / '+available+' 个供应商';const browserText=companionSummary(state.companion?.clients);sync.textContent=(state.refreshing?'正在查询使用中供应商':'本机数据已同步')+(browserText?' · '+browserText:'')+(state.lastFullRefreshAt?' · 全量刷新 '+age(state.lastFullRefreshAt):'');const emptyMessage=filter==='ignored'?'没有已忽略的供应商':'当前搜索或筛选下没有供应商';grid.replaceChildren(...(shown.length?shown.map(renderProviderRow):[el('div','empty',emptyMessage)]));if(diagnosticDialog.open)renderDiagnostics()}
    function methodRow(label,value,wide=false,code=false){const row=el('div','method-row'+(wide?' wide':''));row.append(el('dt','method-label',label),el('dd','method-value'+(code?' code':''),value||'--'));return row}
    function templateFor(type,id){const templates=templateCatalog?.[type]||[];return templates.find(item=>item.id===id)||null}
    function fillTemplateSelect(select,type,currentId,source){const templates=templateCatalog?.[type]||[];const choices=templates.filter(item=>item.selectable||item.id===currentId);select.replaceChildren(...choices.map(item=>{const option=el('option','',item.label+(item.id===currentId?(source==='manual'?' · 已绑定':' · 内置'):''));option.value=item.id;option.dataset.selectable=String(item.selectable===true);return option}));select.value=currentId;if(!select.value&&choices[0])select.value=choices[0].id}
    function updateTemplateDescriptions(){if(!methodItem||!templateCatalog)return;const selection=methodItem.templateSelection||{};const balance=templateFor('balance',balanceTemplate.value);const request=templateFor('requestUsage',requestTemplate.value);const balanceState=balanceTemplate.value===selection.balanceTemplateId?(selection.balanceSource==='manual'?'当前手动绑定':'当前内置识别'):'尚未保存';const requestState=requestTemplate.value===selection.requestUsageTemplateId?(selection.requestUsageSource==='manual'?'当前手动绑定':'当前内置识别'):'尚未保存';balanceTemplateDescription.textContent=(balance?.description||'')+(balance?' · '+balanceState:'');requestTemplateDescription.textContent=(request?.description||'')+(request?' · '+requestState:'')}
    function setTemplateBusy(busy){for(const button of templateButtons)button.disabled=busy;balanceTemplate.disabled=busy;requestTemplate.disabled=busy}
    function probePreview(preview){if(!preview)return'';const labels={providerName:'供应商',remaining:'剩余',used:'已用',total:'总额',unit:'单位',source:'来源',requestCount:'记录数',costUnit:'计费单位',costExact:'精确扣费'};return Object.entries(preview).filter(([,value])=>value!==null&&value!==''&&value!==undefined).map(([key,value])=>(labels[key]||key)+'：'+(typeof value==='boolean'?(value?'是':'否'):value)).join(' · ')}
    function renderProbeResult(payload){templateResult.replaceChildren();for(const [title,group] of [['余额额度',payload.balance],['逐请求 Token / 扣费',payload.requestUsage]]){const wrap=el('div','probe-group');wrap.append(el('div','probe-title',title+(group?.recommendedTemplateId?' · 建议 '+(templateFor(title==='余额额度'?'balance':'requestUsage',group.recommendedTemplateId)?.label||group.recommendedTemplateId):'')));for(const result of group?.results||[]){const message=[result.label,result.status==='success'?'调用成功':result.status==='needs-action'?'需要登录或授权':'未匹配',result.message,probePreview(result.preview)].filter(Boolean).join(' · ');wrap.append(el('div','probe-line '+result.status,message))}templateResult.append(wrap)}templateResult.hidden=false}
    async function loadTemplateCatalog(item){const response=await fetch(API+'/templates?providerId='+encodeURIComponent(item.id),{cache:'no-store'});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.message||'模板目录不可用');if(methodItem?.id!==item.id)return;templateCatalog=payload;const selection=payload.selection||item.templateSelection||{};fillTemplateSelect(balanceTemplate,'balance',selection.balanceTemplateId,selection.balanceSource);fillTemplateSelect(requestTemplate,'requestUsage',selection.requestUsageTemplateId,selection.requestUsageSource);updateTemplateDescriptions()}
    function renderQueryMethod(item){const method=item.queryMethod||{};const companion=state.companion||{connected:false,clients:[]};const browsers=[...new Set((companion.clients||[]).map(client=>client.browser).filter(Boolean))];const browserRequirement=method.requiresBrowser?'需要 · 复用当前浏览器 Cookie / WAF 登录态':method.waf?'可选回退 · 直接请求受阻时使用当前浏览器':'不依赖浏览器';const companionStatus=(method.requiresBrowser||method.waf)?(companion.connected?'已自动连接'+(browsers.length?'（'+browsers.join('/')+'）':''):'未连接 · 首次配对后会自动重连'):'此方案不需要浏览器伴侣';const statusLabel=statusMeta(item)[0];const selection=item.templateSelection||{};methodTitle.textContent=item.name;methodSubtitle.textContent=(method.label||'该供应商尚未匹配到内置查询方案')+' · 余额 '+(selection.balanceSource==='manual'?'手动模板':'内置模板')+' / 逐请求 '+(selection.requestUsageSource==='manual'?'手动模板':'内置模板');methodFields.replaceChildren(methodRow('请求地址',method.requestUrl||'没有已知的直接余额接口',true,true),methodRow('官方登录页',item.loginUrl||'不需要网页登录',true,true),methodRow('HTTP 方法',method.method||'GET'),methodRow('认证方式',method.authentication||'未配置'),methodRow('执行位置',method.executor||'Balance Hub 本机宿主',true),methodRow('Cookie / WAF',browserRequirement,true),methodRow('浏览器伴侣',companionStatus,true),methodRow('当前状态',statusLabel),methodRow('当前结果来源',sourceLabel(item)));const notes=Array.isArray(method.notes)?method.notes.filter(Boolean):[];if(method.requiresBrowser||method.waf)notes.push('连接码与 clientId 保存在浏览器 chrome.storage.local；平时无需打开伴侣弹窗。');methodNoteList.replaceChildren(...notes.map(note=>el('li','',note)));methodNotes.hidden=notes.length===0}
    async function showQueryMethod(item){methodItem=item;templateCatalog=null;templateResult.hidden=true;balanceTemplate.replaceChildren();requestTemplate.replaceChildren();balanceTemplateDescription.textContent='正在读取模板…';requestTemplateDescription.textContent='正在读取模板…';renderQueryMethod(item);if(typeof methodDialog.showModal==='function'){if(!methodDialog.open)methodDialog.showModal()}else{methodDialog.setAttribute('open','')}try{await loadTemplateCatalog(item)}catch(error){showToast(error.message);balanceTemplateDescription.textContent=error.message;requestTemplateDescription.textContent=error.message}}
    async function probeTemplateSelection(automatic){if(!methodItem||!templateCatalog)return;const body={providerId:methodItem.id};if(!automatic){const balance=templateFor('balance',balanceTemplate.value);const request=templateFor('requestUsage',requestTemplate.value);if(balance?.selectable)body.balanceTemplateId=balance.id;if(request?.selectable)body.requestUsageTemplateId=request.id}setTemplateBusy(true);templateResult.hidden=false;templateResult.textContent='正在验证第三方响应结构…';try{const result=await post('template-probe',body);renderProbeResult(result);if(automatic){const balanceId=result.balance?.recommendedTemplateId||result.balance?.fallbackTemplateId;const requestId=result.requestUsage?.recommendedTemplateId;if(balanceId&&templateFor('balance',balanceId)?.selectable)balanceTemplate.value=balanceId;if(requestId&&templateFor('requestUsage',requestId)?.selectable)requestTemplate.value=requestId;updateTemplateDescriptions()}showToast(automatic?'识别完成，请确认后保存':'模板测试完成')}catch(error){templateResult.textContent=error.message;showToast(error.message)}finally{setTemplateBusy(false)}}
    async function saveTemplateSelection(){if(!methodItem||!templateCatalog)return;const balance=templateFor('balance',balanceTemplate.value);const request=templateFor('requestUsage',requestTemplate.value);const selection=methodItem.templateSelection||{};const balanceId=balance?.selectable&&(selection.balanceSource==='manual'||balance.id!==selection.balanceTemplateId)?balance.id:'';const requestId=request?.selectable&&(selection.requestUsageSource==='manual'||request.id!==selection.requestUsageTemplateId)?request.id:'';setTemplateBusy(true);try{const result=await post('template-selection',{providerId:methodItem.id,balanceTemplateId:balanceId,requestUsageTemplateId:requestId});methodItem=result.provider;const index=(state.providers||[]).findIndex(item=>item.id===methodItem.id);if(index>=0)state.providers[index]=methodItem;renderQueryMethod(methodItem);await loadTemplateCatalog(methodItem);showToast('模板已保存，余额将在下次刷新时按新模板查询')}catch(error){showToast(error.message)}finally{setTemplateBusy(false)}}
    async function resetTemplateSelection(){if(!methodItem)return;setTemplateBusy(true);try{const result=await post('template-selection',{providerId:methodItem.id,action:'clear'});methodItem=result.provider;const index=(state.providers||[]).findIndex(item=>item.id===methodItem.id);if(index>=0)state.providers[index]=methodItem;renderQueryMethod(methodItem);await loadTemplateCatalog(methodItem);templateResult.hidden=true;showToast('已恢复内置模板')}catch(error){showToast(error.message)}finally{setTemplateBusy(false)}}
    async function load(){try{const response=await fetch(API+'/state',{cache:'no-store'});if(!response.ok)throw new Error('Hub 服务不可用');const next=await response.json();const nextRenderKey=stateRenderKey(next);const authChanged=reconcileAuthChecks(next);const shouldRender=authChanged||nextRenderKey!==renderKey||Date.now()-lastRenderedAt>=60000;state=next;if(shouldRender){renderKey=nextRenderKey;render()}}catch(error){sync.textContent=error.message}}
    async function loadCompanionStatus(){try{const response=await fetch(API+'/companion/status',{cache:'no-store'});if(!response.ok)return;const payload=await response.json();const next={...state,companion:payload.companion||{connected:false,clients:[]},diagnostics:payload.diagnostics||state.diagnostics};const nextRenderKey=stateRenderKey(next);state=next;if(nextRenderKey!==renderKey){renderKey=nextRenderKey;render()}}catch{}}
    function scheduleOperationMonitor(){clearTimeout(operationMonitorTimer);operationMonitorDeadline=Date.now()+600000;const monitor=async()=>{if(document.visibilityState==='hidden'||Date.now()>=operationMonitorDeadline)return;await load();const checking=[...authChecks.values()].some(entry=>entry.phase==='checking');if(state.refreshing||checking)operationMonitorTimer=setTimeout(monitor,750)};operationMonitorTimer=setTimeout(monitor,100)}
    function scheduleCompanionMonitor(delay=5000){clearTimeout(companionMonitorTimer);if(document.visibilityState==='hidden')return;companionMonitorTimer=setTimeout(async()=>{await loadCompanionStatus();scheduleCompanionMonitor()},delay)}
    refreshAll.addEventListener('click',async()=>{const providerIds=activeProviders().map(item=>item.id);try{await post('refresh',{providerIds});showToast('已开始刷新使用中的供应商');scheduleOperationMonitor()}catch(error){showToast(error.message)}await load()});
    activationRefresh.addEventListener('click',()=>{const current=activeProviders().find(item=>item.current);if(current)refreshOne(current.id)});
    activationBrowser.addEventListener('click',copyCompanionToken);
    activationComplete.addEventListener('click',completeSetup);
    copyCompanion.addEventListener('click',copyCompanionToken);
    openDiagnosticsButton.addEventListener('click',()=>openDiagnostics());
    openTrustButton.addEventListener('click',openTrust);
    searchInput.addEventListener('input',()=>{query=searchInput.value;render()});
    sortSelect.addEventListener('change',()=>saveSort(sortSelect.value));
    viewButtons.forEach(button=>button.addEventListener('click',()=>saveView(button.dataset.view)));
    document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(item=>{item.classList.remove('active');item.setAttribute('aria-selected','false')});tab.classList.add('active');tab.setAttribute('aria-selected','true');filter=tab.dataset.filter;render()}));
    document.getElementById('diagnostic-close').addEventListener('click',()=>diagnosticDialog.close());
    document.getElementById('diagnostic-recheck').addEventListener('click',load);
    document.getElementById('copy-diagnostics').addEventListener('click',copyDiagnosticReport);
    diagnosticDialog.addEventListener('click',event=>{if(event.target===diagnosticDialog)diagnosticDialog.close()});
    document.getElementById('trust-close').addEventListener('click',()=>trustDialog.close());
    document.getElementById('trust-done').addEventListener('click',()=>trustDialog.close());
    trustDialog.addEventListener('click',event=>{if(event.target===trustDialog)trustDialog.close()});
    balanceTemplate.addEventListener('change',updateTemplateDescriptions);
    requestTemplate.addEventListener('change',updateTemplateDescriptions);
    document.getElementById('template-detect').addEventListener('click',()=>probeTemplateSelection(true));
    document.getElementById('template-test').addEventListener('click',()=>probeTemplateSelection(false));
    document.getElementById('template-save').addEventListener('click',saveTemplateSelection);
    document.getElementById('template-reset').addEventListener('click',resetTemplateSelection);
    document.getElementById('method-close').addEventListener('click',()=>methodDialog.close());
    methodDialog.addEventListener('click',event=>{if(event.target===methodDialog)methodDialog.close()});
    window.addEventListener('blur',markHubLeft);
    window.addEventListener('focus',()=>setTimeout(maybeAutoCheckPending,120));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){markHubLeft();clearTimeout(companionMonitorTimer);return}load().then(()=>{if(state.refreshing||[...authChecks.values()].some(entry=>entry.phase==='checking'))scheduleOperationMonitor();scheduleCompanionMonitor();maybeAutoCheckPending()})});
    load().then(()=>{if(state.refreshing||[...authChecks.values()].some(entry=>entry.phase==='checking'))scheduleOperationMonitor();scheduleCompanionMonitor();maybeAutoCheckPending();if(location.hash==='#diagnostics'||new URLSearchParams(location.search).get('view')==='diagnostics')openDiagnostics()});
  </script>
</body>
</html>`;
}
