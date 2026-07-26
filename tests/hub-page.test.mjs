import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserTaskKind,
  buildHubPage,
  hubLoginLink,
  hubProviderMessage,
  hubProviderNeedsAttention,
  resolveProviderBrowser,
} from '../src/hub-page.mjs';

test('Hub translates machine errors while retaining technical details on demand', () => {
  const item = { message: 'active_codex_subscription_not_found' };
  assert.equal(hubProviderMessage(item), '当前账号没有可用的 Codex 订阅');
  assert.equal(
    hubProviderMessage(item, true),
    '当前账号没有可用的 Codex 订阅；技术信息：active_codex_subscription_not_found',
  );
  assert.equal(hubProviderMessage({ message: 'Failed to fetch' }), '暂时无法连接供应商，请检查网络或浏览器网站权限');
  assert.equal(hubProviderMessage({ message: '君的公益本地已用估算' }), '君的公益本地已用估算');
});

test('Hub keeps retried failures in attention views until the query completes', () => {
  assert.equal(hubProviderNeedsAttention({ status: 'loading', lastAttemptAt: '2026-07-26T00:00:00.000Z' }), true);
  assert.equal(hubProviderNeedsAttention({ status: 'loading', lastAttemptAt: '' }), false);
  assert.equal(hubProviderNeedsAttention({ status: 'ok', lastAttemptAt: '2026-07-26T00:00:00.000Z' }), false);
});

test('browser providers always retain an official login link across quota states', () => {
  const base = { loginUrl: 'https://anyrouter.top/login', websiteUrl: '' };
  for (const status of ['ok', 'degraded', 'error', 'login-required']) {
    const link = hubLoginLink({ ...base, status });
    assert.equal(link.href, 'https://anyrouter.top/login');
    assert.equal(link.label, status === 'ok' ? '官网登录' : '重新登录官网');
  }
});

test('session synchronization remains separate from the always-available official login link', () => {
  const link = hubLoginLink({
    loginUrl: 'https://agentrouter.org/login',
    status: 'login-required',
    sessionSyncRequired: true,
  });
  assert.deepEqual(link, {
    href: 'https://agentrouter.org/login',
    label: '官网登录',
    primary: false,
  });
});

test('official login links reject non-HTTPS and credential-bearing URLs', () => {
  assert.equal(hubLoginLink({ loginUrl: 'http://anyrouter.top/login' }), null);
  assert.equal(hubLoginLink({ loginUrl: 'https://user:password@anyrouter.top/login' }), null);
});

test('browser ownership resolves from a unique verified website session', () => {
  const clients = [
    { ref: 'edge-ref-one', browser: 'Edge', label: 'Edge', sessions: ['https://muyuan.do'] },
    { ref: 'chrome-ref-one', browser: 'Chrome', label: 'Chrome', sessions: ['https://chatgpt.com'] },
  ];
  const resolved = resolveProviderBrowser({
    id: 'muyuan',
    loginUrl: 'https://muyuan.do/login',
  }, clients, {});

  assert.equal(resolved.clientRef, 'edge-ref-one');
  assert.equal(resolved.label, 'Edge');
  assert.equal(resolved.reason, 'session');
});

test('a provider browser choice overrides session inference and retains its alias', () => {
  const clients = [
    { ref: 'edge-ref-one', browser: 'Edge', label: 'Edge', sessions: ['https://muyuan.do'] },
    { ref: 'chrome-ref-one', browser: 'Chrome', label: 'Chrome 公益账号', sessions: [] },
  ];
  const resolved = resolveProviderBrowser({
    id: 'muyuan',
    loginUrl: 'https://muyuan.do/login',
  }, clients, {
    providerBrowsers: { muyuan: { clientRef: 'chrome-ref-one', browser: 'Chrome' } },
  });

  assert.equal(resolved.clientRef, 'chrome-ref-one');
  assert.equal(resolved.label, 'Chrome 公益账号');
  assert.equal(resolved.reason, 'preference');
});

test('browser ownership reports offline bindings and ambiguous sessions without guessing', () => {
  const offline = resolveProviderBrowser({
    id: 'anyrouter',
    accountBinding: { clientRef: 'edge-ref-one', browser: 'Edge' },
  }, [], {});
  assert.equal(offline.state, 'offline');
  assert.equal(offline.label, 'Edge');

  const ambiguous = resolveProviderBrowser({
    id: 'muyuan',
    loginUrl: 'https://muyuan.do/login',
  }, [
    { ref: 'edge-ref-one', browser: 'Edge', sessions: ['https://muyuan.do'] },
    { ref: 'chrome-ref-one', browser: 'Chrome', sessions: ['https://muyuan.do'] },
  ], {});
  assert.equal(ambiguous.state, 'ambiguous');
  assert.equal(ambiguous.clientRef, '');
});

test('browser tasks prioritize binding, synchronization, and website authentication', () => {
  assert.equal(browserTaskKind({ accountBindingRequired: true, sessionSyncRequired: true }), 'binding');
  assert.equal(browserTaskKind({ sessionSyncRequired: true, websiteLoginRequired: true }), 'sync');
  assert.equal(browserTaskKind({ websiteLoginRequired: true }), 'authentication');
  assert.equal(browserTaskKind({ status: 'login-required', loginSupported: true, sessionSyncSupported: true }), 'sync');
  assert.equal(browserTaskKind({ status: 'ok', loginSupported: true }), '');
});

test('Hub exposes every connected browser and routes authentication to the selected companion', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /function companionTargets\(\)/);
  assert.match(page, /client\?\.ref&&client\?\.browser/);
  assert.match(page, /'在 '\+target\.label\+' '\+verb/);
  assert.match(page, /=>login\(item\.id,target\.ref,target\.browser\)/);
  assert.match(page, /clientRef/);
  assert.match(page, /browser\+.*' 已连接'/);
  assert.doesNotMatch(page, /在伴侣浏览器中验证/);
  assert.match(page, /if\(item\.sessionSyncRequired&&!companionConnected\)/);
  assert.match(page, /el\('span','browser-status '\+browserMeta\[1\]/);
  assert.match(page, /'浏览器：'\+info\.label/);
  assert.match(page, /function rememberProviderBrowser\(id,clientRef,browser\)/);
  assert.match(page, /providerBrowser:\{providerId:id,clientRef,browser\}/);
  assert.match(page, /'在 '\+target\.label\+' 认证'/);
  assert.match(page, /function providerRefreshAction\(item\)/);
  assert.match(page, /!ignored&&\(item\.accountBindingRequired\|\|item\.sessionSyncRequired\|\|item\.websiteLoginRequired\)\)rowActions\.append\(providerRefreshAction\(item\)\)/);
});

test('visible Hub pages refresh companion status without polling full provider state', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /API\+'\/companion\/status'/);
  assert.match(page, /function scheduleCompanionMonitor\(delay=5000\)/);
  assert.match(page, /loadCompanionStatus\(\)/);
  assert.match(page, /document\.visibilityState==='hidden'/);
  assert.doesNotMatch(page, /setInterval\(load/);
});

test('Hub resumes operation monitoring when loaded during an active refresh', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(
    page,
    /load\(\)\.then\(\(\)=>\{if\(state\.refreshing\|\|\[\.\.\.authChecks\.values\(\)\]\.some\(entry=>entry\.phase==='checking'\)\)scheduleOperationMonitor\(\)/,
  );
});

test('Hub exposes explicit AnyRouter browser binding controls', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /accountBindingSupported/);
  assert.match(page, /function bindAccount\(/);
  assert.match(page, /function clearAccountBinding\(/);
  assert.match(page, /'绑定 '\+target\.label/);
  assert.match(page, /'改绑 '\+target\.label/);
  assert.match(page, /'已绑定 '\+target\.label/);
  assert.match(page, /解除绑定/);
  assert.match(page, /account-binding/);
  assert.match(page, /class="provider-list cards"/);
  assert.match(page, /function revealProvider\(providerId\)/);
});

test('Hub labels browser-owned balances and API-key-only balances without raw source ids', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /welfare_account:'无名公益站账户总额度'/);
  assert.match(page, /welfare_api_key:'无名公益站 API Key 额度（无需官网登录）'/);
  assert.match(page, /muyuan_local_usage:'君的公益本地用量估算'/);
  assert.match(page, /provider_api:'供应商 API（API Key，无需官网登录）'/);
  assert.doesNotMatch(page, /welfare_account:'welfare_account'/);
});

test('Hub keeps API-key-only mode visible before a successful query produces a source id', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /function sourceLabel\(item\)/);
  assert.match(page, /type==='api-key'.*API Key 直查（无需官网登录）/);
  assert.match(page, /type==='api-health'.*API Key 健康检查（无需官网登录）/);
  assert.match(page, /sourceLabel\(item\).*age\(balanceUpdatedAt\)/);
});

test('Hub configures balance and request usage templates independently', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /id="balance-template"/);
  assert.match(page, /id="request-template"/);
  assert.match(page, /余额额度模板/);
  assert.match(page, /逐请求 Token \/ 扣费模板/);
  assert.match(page, /template-probe/);
  assert.match(page, /template-selection/);
  assert.match(page, /自动识别/);
  assert.match(page, /测试所选/);
  assert.match(page, /恢复内置/);
  assert.match(page, /识别完成，请确认后保存/);
  assert.doesNotMatch(page, /templateResult\.innerHTML/);
});

test('Hub presents searchable card and compact views with persistent workspace preferences', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /id="provider-search"/);
  assert.match(page, /id="provider-sort"/);
  assert.match(page, /id="provider-surface" class="provider-list cards"/);
  assert.match(page, /data-view="cards"/);
  assert.match(page, /data-view="compact"/);
  assert.match(page, /data-filter="favorites"/);
  assert.match(page, /data-filter="browser"/);
  assert.match(page, /data-filter="ignored"/);
  assert.match(page, /const cardMetrics=el\('div','card-metrics'\)/);
  assert.match(page, /\['已用',usage\?\.used,''\].*\['剩余',usage\?\.remaining,'remaining'\].*\['总额',usage\?\.total,''\]/);
  assert.match(page, /\.provider-list\.cards \.card-metrics\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(page, /@media\(max-width:840px\).*\.provider-list\.cards #provider-list\{grid-template-columns:1fr\}/);
  assert.doesNotMatch(page, /@media\(max-width:1080px\).*\.provider-list\.cards #provider-list\{grid-template-columns:1fr\}/);
  assert.match(page, /function renderProviderRow\(item\)/);
  assert.match(page, /function orderedProviders\(providers\)/);
  assert.match(page, /async function toggleFavorite\(id\)/);
  assert.match(page, /async function toggleIgnored\(id\)/);
  assert.match(page, /ignoredProvider:\{providerId:id,ignored\}/);
  assert.match(page, /filter==='ignored'/);
  assert.match(page, /post\('refresh',\{providerIds\}\)/);
  assert.match(page, /async function saveView\(value\)/);
  assert.match(page, /post\('preferences',\{view:value\}\)/);
  assert.match(page, /view=state\.preferences\?\.view==='compact'\?'compact':'cards'/);
  assert.match(page, /button\.disabled=Boolean\(item\.refreshing\);return button/);
  assert.match(page, /@media\(max-width:560px\).*grid-template-areas:"favorite identity" "\. meta" "\. status"/);
  assert.match(page, /\.provider-list\.cards \.row-actions\{grid-area:actions;/);
  assert.match(page, /post\('preferences'/);
  assert.match(page, /aria-label','更多操作'/);
  assert.doesNotMatch(page, /function renderCard\(item\)/);
});

test('Hub presents a bounded first-run status check that stores only completion state', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /id="activation"/);
  assert.match(page, /function renderActivation\(providers\)/);
  assert.match(page, /diagnostics\.connectedPages/);
  assert.match(page, /current\?\.usage&&\['ok','degraded'\]/);
  assert.match(page, /async function completeSetup\(\)/);
  assert.match(page, /post\('preferences',\{setupComplete:true\}\)/);
  assert.match(page, /activationRefresh\.addEventListener/);
  assert.match(page, /activationBrowser\.addEventListener\('click',copyCompanionToken\)/);
  assert.doesNotMatch(page, /activation.*API Key/i);
});

test('Hub groups browser tasks and supports scoped batch processing', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /id="browser-tasks"/);
  assert.match(page, /function browserTaskGroupsFor\(providers\)/);
  assert.match(page, /function runBrowserTaskGroup\(group\)/);
  assert.match(page, /function refreshBrowserTaskGroup\(group\)/);
  assert.match(page, /requestLogin\(task\.item\.id,group\.target\.ref,group\.target\.browser\)/);
  assert.match(page, /requestBinding\(task\.item\.id,group\.target\.ref,group\.target\.browser\)/);
  assert.match(page, /group\.tasks\.map\(task=>task\.item\.id\)/);
  assert.match(page, /处理全部/);
  assert.match(page, /重新检查全部/);
});

test('Hub auto-checks once after returning from authentication and retains a manual retry', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /ccswitch-hub-auth-checks-v1/);
  assert.match(page, /entry\.phase==='waiting'&&entry\.leftAt>0/);
  assert.match(page, /entry\.phase='checking'/);
  assert.match(page, /authCheckPromise=refreshProviders\(ids,\{trackAuth:true,quiet:true\}\)/);
  assert.match(page, /window\.addEventListener\('blur',markHubLeft\)/);
  assert.match(page, /window\.addEventListener\('focus'.*maybeAutoCheckPending/);
  assert.match(page, /pending\?\.phase==='manual'.*我已完成认证，重新检查/);
  assert.doesNotMatch(page, /setInterval\(maybeAutoCheckPending/);
});

test('Hub exposes a diagnostics drawer, browser aliases, and a redacted report', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /id="diagnostic-dialog"/);
  assert.match(page, /id="copy-diagnostics"/);
  assert.match(page, /function diagnosticCheckItems\(\)/);
  assert.match(page, /async function saveBrowserAlias\(clientRef,label\)/);
  assert.match(page, /browserAlias:\{clientRef,label\}/);
  assert.match(page, /browserOrigins:state\.browserOrigins/);
  assert.match(page, /脱敏诊断报告已复制/);
  assert.match(page, /location\.hash==='\#diagnostics'/);
  assert.match(page, /get\('view'\)==='diagnostics'/);
  assert.doesNotMatch(page, /API Key.*JSON\.stringify\(payload/);
});

test('Hub exposes an operable privacy and security dialog', () => {
  const page = buildHubPage({ apiBase: '/api/test-token', nonce: 'test-nonce' });

  assert.match(page, /id="open-trust"/);
  assert.match(page, /id="trust-dialog"/);
  assert.match(page, /function openTrust\(\)/);
  assert.match(page, /openTrustButton\.addEventListener\('click',openTrust\)/);
  assert.match(page, /id="trust-close"/);
  assert.match(page, /id="trust-done"/);
  assert.match(page, /CCSwitch 数据库保持只读/);
  assert.match(page, /不包含遥测/);
  assert.match(page, /不包含 API Key、Cookie、Bearer Token 或请求正文/);
});
