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
    .card-actions{display:flex;gap:7px;flex:0 0 auto}
    .empty{grid-column:1/-1;padding:64px 20px;border:1px dashed var(--line);border-radius:16px;color:var(--muted);text-align:center}
    .privacy{display:flex;gap:10px;align-items:flex-start;margin-top:22px;padding:14px 16px;border:1px solid var(--line);border-radius:13px;background:rgba(18,20,25,.62);color:var(--muted);font-size:12px;line-height:1.6}
    .privacy strong{color:var(--soft)}
    .toast{position:fixed;right:18px;bottom:18px;max-width:min(400px,calc(100vw - 36px));padding:11px 14px;border:1px solid var(--line);border-radius:11px;background:#20242b;color:var(--text);box-shadow:0 16px 40px rgba(0,0,0,.38);font-size:13px;opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease}
    .toast.show{opacity:1;transform:translateY(0)}
    @media(max-width:760px){.shell{width:min(100% - 20px,1180px);padding-top:24px}.topbar{display:block}.actions{justify-content:flex-start;margin-top:18px}.overview{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.toolbar{align-items:flex-end}.sync{display:none}}
    @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f5f7;--panel:#fff;--panel-2:#f6f7f9;--line:#dfe2e7;--text:#17191d;--muted:#6d737d;--soft:#343940}.card{background:linear-gradient(145deg,#fff,#f8f9fb)}.metric{background:#f2f3f6}.button.primary{background:#17191d;color:#fff}.button.primary:hover{background:#000}.toast{background:#fff}.badge{background:#edf0f3}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div><div class="eyebrow"><span class="logo"></span>CCSwitch · Local only</div><h1>Balance Hub <span style="color:var(--blue)">v2</span></h1><p class="subtitle">统一查看 CCSwitch 中所有 Codex / GPT 供应商的额度，并在网页登录失效时修复专用会话。</p></div>
      <div class="actions"><button id="refresh-all" class="button primary" type="button">刷新全部</button></div>
    </header>
    <section class="overview" aria-label="汇总"><div class="stat"><span class="stat-label">全部供应商</span><strong id="count-all" class="stat-value">--</strong></div><div class="stat"><span class="stat-label">查询正常</span><strong id="count-ok" class="stat-value">--</strong></div><div class="stat"><span class="stat-label">需要处理</span><strong id="count-attention" class="stat-value">--</strong></div><div class="stat"><span class="stat-label">正在查询</span><strong id="count-loading" class="stat-value">--</strong></div></section>
    <div class="toolbar"><div class="tabs" role="tablist"><button class="tab active" data-filter="all">全部</button><button class="tab" data-filter="ok">正常</button><button class="tab" data-filter="attention">需处理</button></div><span id="sync" class="sync">等待本机服务…</span></div>
    <section id="grid" class="grid" aria-live="polite"></section>
    <aside class="privacy"><span aria-hidden="true">🔒</span><div><strong>凭据不会进入这个页面。</strong> API Key、Cookie 与 OpenAI Token 只在本机宿主内存中用于请求；Hub 页面只接收归一化后的余额和状态。CCSwitch 数据库始终只读。</div></aside>
  </main>
  <div id="toast" class="toast" role="status"></div>
  <script nonce="${nonce}">
    const API=${safeApiBase};
    const grid=document.getElementById('grid');
    const refreshAll=document.getElementById('refresh-all');
    const sync=document.getElementById('sync');
    const toast=document.getElementById('toast');
    const number=new Intl.NumberFormat(undefined,{maximumFractionDigits:2});
    let state={providers:[],refreshing:false};
    let filter='all';
    let toastTimer=0;
    const sourceNames={usage_script:'CCSwitch 用量脚本',official_api:'官方 API',provider_api:'供应商 API',openai_wham:'OpenAI 用量接口',openai_wham_browser:'OpenAI 用量接口（Edge）',cpa_auth_files:'CLIProxyAPI 本地账号',browser_session:'v2 网页会话',ccswitch_cookie:'CCSwitch Cookie',legacy_bridge:'兼容旧桥接',api_health_and_local_usage:'API 健康检查 + 本地统计'};
    function showToast(message){toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2800)}
    function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node}
    function format(value,unit=''){if(value==null||value==='')return '--';const numeric=Number(value);return Number.isFinite(numeric)?number.format(numeric)+(unit?' '+unit:''):'--'}
    function age(value){const time=Date.parse(value||'');if(!Number.isFinite(time))return '尚未更新';const minutes=Math.max(0,Math.floor((Date.now()-time)/60000));if(minutes<1)return '刚刚更新';if(minutes<60)return minutes+' 分钟前';if(minutes<1440)return Math.floor(minutes/60)+' 小时前';return Math.floor(minutes/1440)+' 天前'}
    function statusMeta(item){if(item.refreshing||item.status==='loading')return ['查询中','loading'];if(item.status==='ok')return ['正常','ok'];if(item.status==='degraded')return ['受限','warning'];if(item.status==='login-required')return ['需要登录','warning'];if(item.status==='idle')return ['等待查询',''];return ['查询失败','error']}
    function action(label,handler,primary=false){const button=el('button','button small'+(primary?' primary':''),label);button.type='button';button.addEventListener('click',handler);return button}
    async function post(route,body={}){const response=await fetch(API+'/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.message||'本机 Hub 请求失败');return payload}
    async function refreshOne(id){try{await post('refresh',{providerId:id});showToast('已开始重新查询')}catch(error){showToast(error.message)}await load()}
    async function login(id){try{await post('login',{providerId:id});showToast('已打开专用 Edge 登录页')}catch(error){showToast(error.message)}await load()}
    function renderCard(item){const card=el('article','card'+(item.current?' current':''));const head=el('div','card-head');const titleWrap=el('div');titleWrap.append(el('h2','provider-name',item.name));const badges=el('div','badges');const [label,tone]=statusMeta(item);badges.append(el('span','badge '+tone,label));if(item.current)badges.append(el('span','badge current-label','CCSwitch 当前'));titleWrap.append(badges);head.append(titleWrap);card.append(head);
      const usage=item.usage;const metrics=el('div','metric-row');for(const [labelText,value,className] of [['已用',format(usage?.used,usage?.unit),''],['剩余',format(usage?.remaining,usage?.unit),'remaining'],['总额',format(usage?.total,usage?.unit),'']]){const metric=el('div','metric');metric.append(el('span','metric-label',labelText),el('strong','metric-value '+className,value));metrics.append(metric)}card.append(metrics);
      const progress=el('div','progress');const fill=el('i');const percent=usage&&Number(usage.total)>0&&Number.isFinite(Number(usage.used))?Math.max(0,Math.min(100,Number(usage.used)/Number(usage.total)*100)):0;fill.style.width=percent+'%';progress.append(fill);card.append(progress);
      card.append(el('p','detail',item.message||usage?.extra||'等待第一次查询'));
      const foot=el('div','card-foot');foot.append(el('span','source',(sourceNames[item.source]||item.source||'未选择查询方式')+' · '+age(item.updatedAt||usage?.updatedAt)));const actions=el('div','card-actions');if(item.websiteUrl){const link=el('a','button small','官网');link.href=item.websiteUrl;link.target='_blank';link.rel='noreferrer';actions.append(link)}if(item.loginSupported)actions.append(action(item.status==='login-required'?'去登录':'网页登录',()=>login(item.id),item.status==='login-required'));actions.append(action(item.refreshing?'查询中':'刷新',()=>refreshOne(item.id)));foot.append(actions);card.append(foot);return card}
    function render(){const providers=state.providers||[];document.getElementById('count-all').textContent=providers.length;document.getElementById('count-ok').textContent=providers.filter(item=>item.status==='ok').length;document.getElementById('count-attention').textContent=providers.filter(item=>['error','login-required','degraded'].includes(item.status)).length;document.getElementById('count-loading').textContent=providers.filter(item=>item.refreshing||item.status==='loading').length;refreshAll.disabled=Boolean(state.refreshing);refreshAll.textContent=state.refreshing?'正在刷新…':'刷新全部';sync.textContent=(state.refreshing?'正在查询供应商':'本机数据已同步')+(state.lastFullRefreshAt?' · '+age(state.lastFullRefreshAt):'');let shown=providers;if(filter==='ok')shown=shown.filter(item=>item.status==='ok');if(filter==='attention')shown=shown.filter(item=>['error','login-required','degraded'].includes(item.status));grid.replaceChildren(...(shown.length?shown.map(renderCard):[el('div','empty','当前筛选下没有供应商')]))}
    async function load(){try{const response=await fetch(API+'/state',{cache:'no-store'});if(!response.ok)throw new Error('Hub 服务不可用');state=await response.json();render()}catch(error){sync.textContent=error.message}}
    refreshAll.addEventListener('click',async()=>{try{await post('refresh');showToast('已开始刷新全部供应商')}catch(error){showToast(error.message)}await load()});
    document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(item=>item.classList.remove('active'));tab.classList.add('active');filter=tab.dataset.filter;render()}));
    load();setInterval(load,1500);
  </script>
</body>
</html>`;
}
