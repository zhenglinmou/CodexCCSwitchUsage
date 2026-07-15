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
    :root{color-scheme:dark;--bg:#0a0b0d;--panel:#121419;--panel-2:#181b21;--line:#272b33;--text:#f5f6f8;--muted:#999faa;--soft:#c9cdd4;--blue:#6aa9ff;--green:#56d58b;--orange:#ffae66;--red:#ff7474;--violet:#be8cff;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}
    body{margin:0;min-width:320px;background:radial-gradient(circle at 15% -10%,rgba(71,120,255,.16),transparent 34%),radial-gradient(circle at 90% 0,rgba(182,92,255,.12),transparent 28%),var(--bg);color:var(--text)}
    button,a{font:inherit}
    .shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:40px 0 56px}
    .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:28px}
    .eyebrow{display:flex;align-items:center;gap:8px;color:var(--blue);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
    .logo{width:9px;height:9px;border-radius:3px;background:linear-gradient(135deg,var(--blue),var(--violet));box-shadow:0 0 18px rgba(106,169,255,.6)}
    h1{margin:10px 0 8px;font-size:clamp(28px,4vw,44px);line-height:1.05;letter-spacing:-.04em}
    .subtitle{margin:0;color:var(--muted);font-size:14px;line-height:1.6}
    .actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
    .button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 14px;border:1px solid var(--line);border-radius:11px;background:var(--panel-2);color:var(--text);text-decoration:none;cursor:pointer;transition:.16s ease}
    .button:hover{border-color:#3d4552;background:#20242c;transform:translateY(-1px)}
    .button.primary{border-color:transparent;background:#f3f5f8;color:#101216;font-weight:650}
    .button.primary:hover{background:#fff}
    .button:disabled{opacity:.55;cursor:wait;transform:none}
    .button.small{min-height:32px;padding:0 11px;border-radius:9px;font-size:12px}
    .overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:22px}
    .stat{padding:15px 17px;border:1px solid var(--line);border-radius:14px;background:rgba(18,20,25,.78);backdrop-filter:blur(14px)}
    .stat-label{font-size:12px;color:var(--muted)}
    .stat-value{display:block;margin-top:5px;font-size:22px;font-weight:700;letter-spacing:-.03em}
    .toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px}
    .tabs{display:flex;gap:5px;padding:4px;border:1px solid var(--line);border-radius:11px;background:var(--panel)}
    .tab{height:30px;padding:0 11px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:12px}
    .tab.active{background:var(--panel-2);color:var(--text)}
    .sync{font-size:12px;color:var(--muted)}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .card{position:relative;min-height:224px;padding:18px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(145deg,rgba(24,27,33,.94),rgba(17,19,24,.96));overflow:hidden}
    .card::after{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent)}
    .card.current{border-color:rgba(106,169,255,.46);box-shadow:inset 0 0 0 1px rgba(106,169,255,.08)}
    .card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
    .provider-name{margin:0;font-size:16px;font-weight:680;letter-spacing:-.015em;overflow-wrap:anywhere}
    .badges{display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap}
    .badge{display:inline-flex;align-items:center;gap:5px;padding:3px 7px;border-radius:999px;background:#22262e;color:var(--muted);font-size:11px}
    .badge::before{content:"";width:6px;height:6px;border-radius:999px;background:currentColor}
    .badge.ok{color:var(--green);background:rgba(86,213,139,.1)}
    .badge.loading{color:var(--blue);background:rgba(106,169,255,.1)}
    .badge.warning{color:var(--orange);background:rgba(255,174,102,.1)}
    .badge.error{color:var(--red);background:rgba(255,116,116,.1)}
    .badge.current-label{color:var(--blue);background:rgba(106,169,255,.1)}
    .badge.current-label::before{display:none}
    .metric-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:20px 0 13px}
    .metric{min-width:0;padding:10px;border-radius:11px;background:rgba(8,10,13,.46)}
    .metric-label{display:block;color:var(--muted);font-size:11px}
    .metric-value{display:block;margin-top:5px;color:var(--soft);font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .metric-value.remaining{color:var(--violet)}
    .progress{height:4px;border-radius:99px;background:#282c34;overflow:hidden}
    .progress i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--blue),var(--violet));transition:width .3s ease}
    .detail{min-height:36px;margin:12px 0 13px;color:var(--muted);font-size:12px;line-height:18px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
    .card-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto}
    .source{min-width:0;color:#707782;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .card-actions{display:flex;gap:7px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
    .empty{grid-column:1/-1;padding:64px 20px;border:1px dashed var(--line);border-radius:16px;color:var(--muted);text-align:center}
    .privacy{display:flex;gap:10px;align-items:flex-start;margin-top:22px;padding:14px 16px;border:1px solid var(--line);border-radius:13px;background:rgba(18,20,25,.62);color:var(--muted);font-size:12px;line-height:1.6}
    .privacy strong{color:var(--soft)}
    .method-dialog{width:min(680px,calc(100% - 24px));max-height:min(760px,calc(100vh - 32px));padding:0;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--text);box-shadow:0 30px 90px rgba(0,0,0,.58);overflow:hidden}
    .method-dialog::backdrop{background:rgba(2,4,8,.72);backdrop-filter:blur(5px)}
    .method-panel{display:flex;max-height:min(760px,calc(100vh - 32px));flex-direction:column}
    .method-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:21px 22px 17px;border-bottom:1px solid var(--line)}
    .method-kicker{display:block;margin-bottom:6px;color:var(--blue);font-size:11px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}
    .method-title{margin:0;font-size:20px;letter-spacing:-.02em}
    .method-subtitle{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.5}
    .method-close{width:34px;height:34px;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);color:var(--muted);cursor:pointer;font-size:20px;line-height:1}
    .method-close:hover{color:var(--text);border-color:#3d4552}
    .method-body{padding:18px 22px 20px;overflow:auto}
    .method-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0}
    .method-row{min-width:0;padding:11px 12px;border:1px solid var(--line);border-radius:11px;background:var(--panel-2)}
    .method-row.wide{grid-column:1/-1}
    .method-label{color:var(--muted);font-size:11px}
    .method-value{margin:5px 0 0;color:var(--soft);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
    .method-value.code{font-family:"Cascadia Code",Consolas,monospace;font-size:12px}
    .method-notes{margin-top:16px;padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:rgba(8,10,13,.34)}
    .method-notes h3{margin:0 0 7px;font-size:12px;color:var(--soft)}
    .method-notes ul{margin:0;padding-left:18px;color:var(--muted);font-size:12px;line-height:1.65}
    .method-warning{margin:14px 0 0;color:#7e8590;font-size:11px;line-height:1.55}
    .toast{position:fixed;right:18px;bottom:18px;max-width:min(400px,calc(100vw - 36px));padding:11px 14px;border:1px solid var(--line);border-radius:11px;background:#20242b;color:var(--text);box-shadow:0 16px 40px rgba(0,0,0,.38);font-size:13px;opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease}
    .toast.show{opacity:1;transform:translateY(0)}
    @media(max-width:760px){.shell{width:min(100% - 20px,1180px);padding-top:24px}.topbar{display:block}.actions{justify-content:flex-start;margin-top:18px}.overview{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.toolbar{align-items:flex-end}.sync{display:none}.method-fields{grid-template-columns:1fr}.method-row.wide{grid-column:auto}.method-head,.method-body{padding-left:16px;padding-right:16px}}
    @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f5f7;--panel:#fff;--panel-2:#f6f7f9;--line:#dfe2e7;--text:#17191d;--muted:#6d737d;--soft:#343940}.card{background:linear-gradient(145deg,#fff,#f8f9fb)}.metric{background:#f2f3f6}.button.primary{background:#17191d;color:#fff}.button.primary:hover{background:#000}.toast{background:#fff}.badge{background:#edf0f3}.method-dialog::backdrop{background:rgba(33,37,45,.4)}.method-notes{background:#fafbfc}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div><div class="eyebrow"><span class="logo"></span>CCSwitch · Local only</div><h1>Balance Hub <span style="color:var(--blue)">v2</span></h1><p class="subtitle">统一查看 CCSwitch 中所有 Codex / GPT 供应商的额度、真实查询方式与现有浏览器登录状态。</p></div>
      <div class="actions"><button id="copy-companion" class="button" type="button">连接现有浏览器</button><button id="refresh-all" class="button primary" type="button">刷新全部</button></div>
    </header>
    <section class="overview" aria-label="汇总"><div class="stat"><span class="stat-label">全部供应商</span><strong id="count-all" class="stat-value">--</strong></div><div class="stat"><span class="stat-label">查询正常</span><strong id="count-ok" class="stat-value">--</strong></div><div class="stat"><span class="stat-label">需要处理</span><strong id="count-attention" class="stat-value">--</strong></div><div class="stat"><span class="stat-label">正在查询</span><strong id="count-loading" class="stat-value">--</strong></div></section>
    <div class="toolbar"><div class="tabs" role="tablist"><button class="tab active" data-filter="all">全部</button><button class="tab" data-filter="ok">正常</button><button class="tab" data-filter="attention">需处理</button></div><span id="sync" class="sync">等待本机服务…</span></div>
    <section id="grid" class="grid" aria-live="polite"></section>
    <aside class="privacy"><span aria-hidden="true">🔒</span><div><strong>Cookie 不会离开你的日常浏览器。</strong> 连接码保存在浏览器本地，首次配对后会在浏览器启动和宿主重连时自动恢复，不必每次打开伴侣弹窗。API Key 与 OpenAI Token 只在本机宿主内存中用于请求；Hub 页面只接收归一化后的余额和状态，CCSwitch 数据库始终只读。</div></aside>
  </main>
  <dialog id="method-dialog" class="method-dialog" aria-labelledby="method-title">
    <div class="method-panel">
      <header class="method-head"><div><span class="method-kicker">Balance query</span><h2 id="method-title" class="method-title">查询方式</h2><p id="method-subtitle" class="method-subtitle"></p></div><button id="method-close" class="method-close" type="button" aria-label="关闭">×</button></header>
      <div class="method-body"><dl id="method-fields" class="method-fields"></dl><section id="method-notes" class="method-notes"><h3>实现说明</h3><ul id="method-note-list"></ul></section><p class="method-warning">这里只显示请求结构，不显示 API Key、Cookie、Bearer Token、账号文件内容或其他认证原文。</p></div>
    </div>
  </dialog>
  <div id="toast" class="toast" role="status"></div>
  <script nonce="${nonce}">
    const API=${safeApiBase};
    const grid=document.getElementById('grid');
    const refreshAll=document.getElementById('refresh-all');
    const copyCompanion=document.getElementById('copy-companion');
    const sync=document.getElementById('sync');
    const toast=document.getElementById('toast');
    const methodDialog=document.getElementById('method-dialog');
    const methodTitle=document.getElementById('method-title');
    const methodSubtitle=document.getElementById('method-subtitle');
    const methodFields=document.getElementById('method-fields');
    const methodNotes=document.getElementById('method-notes');
    const methodNoteList=document.getElementById('method-note-list');
    const number=new Intl.NumberFormat(undefined,{maximumFractionDigits:2});
    let state={providers:[],refreshing:false};
    let filter='all';
    let renderKey='';
    let lastRenderedAt=0;
    let toastTimer=0;
    const sourceNames={official_api:'官方 API',provider_api:'供应商 API',api_key_probe:'API Key 能力检查',openai_wham:'OpenAI 用量接口',openai_wham_browser:'OpenAI 用量接口（现有浏览器）',cpa_auth_files:'CLIProxyAPI 本地账号',browser_session:'现有浏览器会话',cached_previous:'上次缓存',api_health_and_local_usage:'API 健康检查 + 本地统计'};
    function showToast(message){toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2800)}
    function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node}
    function format(value,unit=''){if(value==null||value==='')return '--';const numeric=Number(value);return Number.isFinite(numeric)?number.format(numeric)+(unit?' '+unit:''):'--'}
    function age(value){const time=Date.parse(value||'');if(!Number.isFinite(time))return '尚未更新';const minutes=Math.max(0,Math.floor((Date.now()-time)/60000));if(minutes<1)return '刚刚更新';if(minutes<60)return minutes+' 分钟前';if(minutes<1440)return Math.floor(minutes/60)+' 小时前';return Math.floor(minutes/1440)+' 天前'}
    function statusMeta(item){if(item.refreshing||item.status==='loading')return ['查询中','loading'];if(item.sessionSyncRequired)return ['需要同步','warning'];if(item.status==='ok')return ['正常','ok'];if(item.status==='degraded')return ['受限','warning'];if(item.status==='login-required')return [item.sessionSyncSupported?'需要同步':'需要登录','warning'];if(item.status==='idle')return ['等待查询',''];return ['查询失败','error']}
    function stateRenderKey(next){const companion=next.companion||{connected:false,clients:[]};const clients=(companion.clients||[]).map(client=>[client.browser,client.version,[...(client.sessions||[])].sort()]);return JSON.stringify([next.revision,next.refreshing,next.lastFullRefreshAt,companion.connected,clients])}
    function action(label,handler,primary=false){const button=el('button','button small'+(primary?' primary':''),label);button.type='button';button.addEventListener('click',handler);return button}
    async function post(route,body={}){const response=await fetch(API+'/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.message||'本机 Hub 请求失败');return payload}
    async function refreshOne(id){try{await post('refresh',{providerId:id});showToast('已开始重新查询')}catch(error){showToast(error.message)}await load()}
    async function login(id){try{const result=await post('login',{providerId:id});showToast(result.provider?.message||(result.provider?.status==='ok'?'同步成功':'操作已完成'))}catch(error){showToast(error.message)}await load()}
    function methodRow(label,value,wide=false,code=false){const row=el('div','method-row'+(wide?' wide':''));row.append(el('dt','method-label',label),el('dd','method-value'+(code?' code':''),value||'--'));return row}
    function showQueryMethod(item){const method=item.queryMethod||{};const companion=state.companion||{connected:false,clients:[]};const browsers=[...new Set((companion.clients||[]).map(client=>client.browser).filter(Boolean))];const browserRequirement=method.requiresBrowser?'需要 · 复用当前浏览器 Cookie / WAF 登录态':method.waf?'可选回退 · 直接请求受阻时使用当前浏览器':'不依赖浏览器';const companionStatus=(method.requiresBrowser||method.waf)?(companion.connected?'已自动连接'+(browsers.length?'（'+browsers.join('/')+'）':''):'未连接 · 首次配对后会自动重连'):'此方案不需要浏览器伴侣';const [statusLabel]=statusMeta(item);methodTitle.textContent=item.name;methodSubtitle.textContent=method.label||'该供应商尚未匹配到内置查询方案';methodFields.replaceChildren(methodRow('请求地址',method.requestUrl||'没有已知的直接余额接口',true,true),methodRow('HTTP 方法',method.method||'GET'),methodRow('认证方式',method.authentication||'未配置'),methodRow('执行位置',method.executor||'Balance Hub 本机宿主',true),methodRow('Cookie / WAF',browserRequirement,true),methodRow('浏览器伴侣',companionStatus,true),methodRow('当前状态',statusLabel),methodRow('当前结果来源',sourceNames[item.source]||item.source||'尚未产生查询结果'));const notes=Array.isArray(method.notes)?method.notes.filter(Boolean):[];if(method.requiresBrowser||method.waf)notes.push('连接码与 clientId 保存在浏览器 chrome.storage.local；平时无需打开伴侣弹窗。');methodNoteList.replaceChildren(...notes.map(note=>el('li','',note)));methodNotes.hidden=notes.length===0;if(typeof methodDialog.showModal==='function'){if(!methodDialog.open)methodDialog.showModal()}else{methodDialog.setAttribute('open','')}}
    function renderCard(item){const card=el('article','card'+(item.current?' current':''));const head=el('div','card-head');const titleWrap=el('div');titleWrap.append(el('h2','provider-name',item.name));const badges=el('div','badges');const [label,tone]=statusMeta(item);badges.append(el('span','badge '+tone,label));if(item.current)badges.append(el('span','badge current-label','CCSwitch 当前'));titleWrap.append(badges);head.append(titleWrap);card.append(head);
      const usage=item.usage;const metrics=el('div','metric-row');for(const [labelText,value,className] of [['已用',format(usage?.used,usage?.unit),''],['剩余',format(usage?.remaining,usage?.unit),'remaining'],['总额',format(usage?.total,usage?.unit),'']]){const metric=el('div','metric');metric.append(el('span','metric-label',labelText),el('strong','metric-value '+className,value));metrics.append(metric)}card.append(metrics);
      const progress=el('div','progress');const fill=el('i');const percent=usage&&Number(usage.total)>0&&Number.isFinite(Number(usage.used))?Math.max(0,Math.min(100,Number(usage.used)/Number(usage.total)*100)):0;fill.style.width=percent+'%';progress.append(fill);card.append(progress);
      card.append(el('p','detail',item.message||usage?.extra||'等待第一次查询'));
      const foot=el('div','card-foot');foot.append(el('span','source',(sourceNames[item.source]||item.source||'未选择查询方式')+' · '+age(item.updatedAt||usage?.updatedAt)));const actions=el('div','card-actions');actions.append(action('查看',()=>showQueryMethod(item)));if(item.websiteUrl){const link=el('a','button small','官网');link.href=item.websiteUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}if(item.loginSupported&&(item.status==='login-required'||item.sessionSyncRequired))actions.append(action(item.sessionSyncSupported?'同步现有会话':'在现有浏览器登录',()=>login(item.id),true));actions.append(action(item.refreshing?'查询中':'刷新',()=>refreshOne(item.id)));foot.append(actions);card.append(foot);return card}
    function render(){lastRenderedAt=Date.now();const providers=state.providers||[];document.getElementById('count-all').textContent=providers.length;document.getElementById('count-ok').textContent=providers.filter(item=>item.status==='ok').length;document.getElementById('count-attention').textContent=providers.filter(item=>['error','login-required','degraded'].includes(item.status)).length;document.getElementById('count-loading').textContent=providers.filter(item=>item.refreshing||item.status==='loading').length;refreshAll.disabled=Boolean(state.refreshing);refreshAll.textContent=state.refreshing?'正在刷新…':'刷新全部';const companion=state.companion||{connected:false,clients:[]};copyCompanion.textContent=companion.connected?'浏览器伴侣已连接':'连接现有浏览器';const browserText=companion.connected?' · '+companion.clients.map(item=>item.browser).join('/')+' 已连接':' · 浏览器伴侣未连接';sync.textContent=(state.refreshing?'正在查询供应商':'本机数据已同步')+browserText+(state.lastFullRefreshAt?' · '+age(state.lastFullRefreshAt):'');let shown=providers;if(filter==='ok')shown=shown.filter(item=>item.status==='ok');if(filter==='attention')shown=shown.filter(item=>['error','login-required','degraded'].includes(item.status));grid.replaceChildren(...(shown.length?shown.map(renderCard):[el('div','empty','当前筛选下没有供应商')]))}
    async function load(){try{const response=await fetch(API+'/state',{cache:'no-store'});if(!response.ok)throw new Error('Hub 服务不可用');const next=await response.json();const nextRenderKey=stateRenderKey(next);const shouldRender=nextRenderKey!==renderKey||Date.now()-lastRenderedAt>=60000;state=next;if(shouldRender){renderKey=nextRenderKey;render()}}catch(error){sync.textContent=error.message}}
    refreshAll.addEventListener('click',async()=>{try{await post('refresh');showToast('已开始刷新全部供应商')}catch(error){showToast(error.message)}await load()});
    copyCompanion.addEventListener('click',async()=>{const token=API.split('/').filter(Boolean).at(-1)||'';try{await navigator.clipboard.writeText(token);showToast(state.companion?.connected?'当前已自动连接，无需重复配置；连接码也已复制':'浏览器伴侣连接码已复制；只需在伴侣弹窗保存一次')}catch{showToast(state.companion?.connected?'当前已自动连接，无需再次打开伴侣':'复制失败，请从本机 runtime/hub-token 读取连接码')}});
    document.getElementById('method-close').addEventListener('click',()=>methodDialog.close());
    methodDialog.addEventListener('click',event=>{if(event.target===methodDialog)methodDialog.close()});
    document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(item=>item.classList.remove('active'));tab.classList.add('active');filter=tab.dataset.filter;render()}));
    load();setInterval(load,1500);
  </script>
</body>
</html>`;
}
