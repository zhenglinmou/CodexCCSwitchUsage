import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserCallbackBroker } from '../src/browser-callback-broker.mjs';
import { getOrCreateHubToken, HubServer, isAllowedHubHost } from '../src/hub-server.mjs';
import { companionHandshake } from '../browser-companion/protocol.js';

test('Hub path token persists across host restarts without becoming guessable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'hub-token');

  const first = getOrCreateHubToken(filename);
  const second = getOrCreateHubToken(filename);

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
});

test('Hub health uses the lightweight service summary instead of building full provider state', async t => {
  let summaryCalls = 0;
  const server = new HubServer({
    getSummary() {
      summaryCalls += 1;
      return { providers: 20, refreshing: true };
    },
    getState() {
      throw new Error('full state should not be built for health');
    },
  }, { port: 0, token: 'test-token', openUrl() {} });
  await server.start();
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.boundPort}/v1/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.providers, 20);
  assert.equal(payload.refreshing, true);
  assert.equal(summaryCalls, 1);
});

test('Hub server protects its local page and API with an unguessable path token', async t => {
  const refreshAllCalls = [];
  const refreshProviderCalls = [];
  const balanceCalls = [];
  const cachedBalanceCalls = [];
  const requestUsageCalls = [];
  const loginCalls = [];
  const bindingCalls = [];
  const templateCalls = [];
  const service = {
    syncProviders() {},
    getState: () => ({ version: 2, providers: [] }),
    listPublicProviders: () => [{ id: 'one', name: 'Agent', aliases: ['one', 'agentrouter'] }],
    queryBalance(selector) {
      balanceCalls.push(selector);
      return Promise.resolve({ success: true, provider: 'one', data: { remaining: 9 } });
    },
    queryAllBalances: () => Promise.resolve({ success: true, data: {} }),
    getBalance(selector) {
      cachedBalanceCalls.push(selector);
      return { success: true, provider: 'one', cache_only: true, data: { remaining: 8 } };
    },
    getAllBalances: () => ({ success: true, cache_only: true, data: {} }),
    queryRequestUsage(selector, options) {
      requestUsageCalls.push({ selector, options });
      return Promise.resolve({
        success: true,
        providerId: 'one',
        source: 'provider_log',
        items: [{ model: 'gpt-5.6-sol', totalCost: 0.01 }],
      });
    },
    findProvider: selector => String(selector) === 'one' ? { id: 'one' } : null,
    refreshAll(providerIds) { refreshAllCalls.push(providerIds); return Promise.resolve(); },
    refreshProvider(selector) { refreshProviderCalls.push(selector); return Promise.resolve(); },
    openLogin(providerId, options) {
      loginCalls.push({ providerId, options });
      return Promise.resolve({ id: 'one' });
    },
    bindAccount(providerId, options) {
      bindingCalls.push({ action: 'bind', providerId, options });
      return Promise.resolve({ id: 'one', accountBinding: { clientRef: options.clientRef, browser: 'Chrome' } });
    },
    clearAccountBinding(providerId) {
      bindingCalls.push({ action: 'clear', providerId });
      return Promise.resolve({ id: 'one', accountBinding: null });
    },
    listTemplates(providerId) {
      templateCalls.push({ action: 'list', providerId });
      return { version: 1, balance: [{ id: 'new-api-key-quota' }], requestUsage: [{ id: 'new-api-token-log' }] };
    },
    probeTemplates(providerId, options) {
      templateCalls.push({ action: 'probe', providerId, options });
      return Promise.resolve({ success: true, balance: { recommendedTemplateId: 'new-api-key-quota' } });
    },
    saveTemplateSelection(providerId, selection) {
      templateCalls.push({ action: 'save', providerId, selection });
      return { id: providerId, templateSelection: selection };
    },
    clearTemplateSelection(providerId) {
      templateCalls.push({ action: 'clear', providerId });
      return { id: providerId, templateSelection: {} };
    },
  };
  const server = new HubServer(service, {
    port: 0,
    token: 'test-token',
    openUrl() {},
    diagnostics: () => ({
      appVersion: '2.0.10', injectorVersion: 82, expectedCompanionVersion: '0.1.24',
      codexProcessId: 52084, hostProcessId: 60000, cdpPort: 9334, connectedPages: 1,
      databaseWatch: true, controlWatch: true, hubRunning: true, hubPort: 17891,
      apiKey: 'must-not-be-exposed',
    }),
  });
  await server.start();
  t.after(() => server.close());

  const page = await fetch(server.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /Balance Hub/);
  assert.match(html, /method-dialog/);
  assert.match(html, /action\('模板'/);
  assert.match(html, /template-probe/);
  assert.match(html, /template-selection/);
  assert.match(html, /同步现有会话/);
  assert.match(html, /sessionSyncSupported/);
  assert.match(html, /item\.sessionSyncRequired/);
  assert.match(html, /item\.websiteLoginRequired/);
  assert.match(html, /loginLinkFor\(item\)/);
  assert.match(html, /重新登录官网/);
  assert.match(html, /官方登录页/);
  assert.doesNotMatch(html, /item\.loginSupported&&\(item\.status==='login-required'/);
  assert.doesNotMatch(html, /setInterval\(load/);
  assert.match(html, /scheduleOperationMonitor/);
  assert.match(html, /scheduleCompanionMonitor/);
  assert.match(html, /\/companion\/status/);
  assert.match(html, /需要同步/);
  assert.doesNotMatch(html, /已在现有浏览器中打开登录页/);
  assert.match(html, /无需重复配置/);
  assert.match(html, /nextRenderKey!==renderKey/);
  assert.match(html, /usage\?\.updatedAt\|\|item\.lastSuccessAt\|\|item\.updatedAt/);
  assert.doesNotMatch(html, /item\.updatedAt\|\|usage\?\.updatedAt/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|access_token/);
  assert.equal(refreshAllCalls.length, 0, 'opening Hub must not refresh providers automatically');

  const state = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/state`);
  const statePayload = await state.json();
  assert.equal(statePayload.version, 2);
  assert.deepEqual(statePayload.providers, []);
  assert.deepEqual(statePayload.companion, { connected: false, clients: [], queuedJobs: 0, pendingJobs: 0 });
  assert.deepEqual(statePayload.preferences, { version: 3, setupComplete: false, favorites: [], ignoredProviders: [], sort: 'smart', view: 'cards', browserAliases: {}, providerBrowsers: {} });
  assert.deepEqual(statePayload.browserOrigins, []);
  assert.equal(statePayload.diagnostics.appVersion, '2.0.10');
  assert.equal(statePayload.diagnostics.connectedPages, 1);
  const companionStatus = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/companion/status`);
  const companionPayload = await companionStatus.json();
  assert.equal(companionPayload.success, true);
  assert.deepEqual(companionPayload.companion, { connected: false, clients: [], queuedJobs: 0, pendingJobs: 0 });
  assert.equal(companionPayload.diagnostics.injectorVersion, 82);
  assert.equal(companionPayload.diagnostics.apiKey, undefined);
  assert.equal(companionPayload.browserOrigins, undefined, 'the five-second companion status stays lightweight');

  const preferenceUpdate = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/preferences`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sort: 'latency',
      view: 'compact',
      setupComplete: true,
      favorite: { providerId: 'one', enabled: true },
      ignoredProvider: { providerId: 'old', ignored: true },
      browserAlias: { clientRef: 'chrome-ref-one', label: 'Chrome 主账号' },
      providerBrowser: { providerId: 'one', clientRef: 'chrome-ref-one', browser: 'Chrome' },
    }),
  });
  assert.deepEqual((await preferenceUpdate.json()).preferences, {
    version: 3,
    setupComplete: true,
    favorites: ['one'],
    ignoredProviders: ['old'],
    sort: 'latency',
    view: 'compact',
    browserAliases: { 'chrome-ref-one': 'Chrome 主账号' },
    providerBrowsers: { one: { clientRef: 'chrome-ref-one', browser: 'Chrome' } },
  });
  const preferences = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/preferences`);
  assert.equal((await preferences.json()).preferences.sort, 'latency');
  const crossSitePreferences = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/preferences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: '{}',
  });
  assert.equal(crossSitePreferences.status, 403);
  const rejected = await fetch(`http://127.0.0.1:${server.boundPort}/api/wrong/state`);
  assert.equal(rejected.status, 404);

  const requestUsage = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/request-usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', limit: 10 }),
  });
  assert.equal(requestUsage.status, 200);
  assert.equal((await requestUsage.json()).source, 'provider_log');
  assert.deepEqual(requestUsageCalls, [{ selector: 'one', options: { limit: 10 } }]);
  const crossSiteRequestUsage = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/request-usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ providerId: 'one', limit: 10 }),
  });
  assert.equal(crossSiteRequestUsage.status, 403);

  const templates = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/templates?providerId=one`);
  assert.equal((await templates.json()).balance[0].id, 'new-api-key-quota');
  const probe = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/template-probe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', balanceTemplateId: 'new-api-key-quota', requestUsageTemplateId: 'new-api-token-log' }),
  });
  assert.equal((await probe.json()).balance.recommendedTemplateId, 'new-api-key-quota');
  const saveTemplate = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/template-selection`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', balanceTemplateId: 'new-api-key-quota', requestUsageTemplateId: 'new-api-token-log' }),
  });
  assert.equal((await saveTemplate.json()).provider.templateSelection.balanceTemplateId, 'new-api-key-quota');
  const clearTemplate = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/template-selection`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', action: 'clear' }),
  });
  assert.equal((await clearTemplate.json()).success, true);
  assert.deepEqual(templateCalls, [
    { action: 'list', providerId: 'one' },
    {
      action: 'probe', providerId: 'one',
      options: { balanceTemplateId: 'new-api-key-quota', requestUsageTemplateId: 'new-api-token-log' },
    },
    {
      action: 'save', providerId: 'one',
      selection: { balanceTemplateId: 'new-api-key-quota', requestUsageTemplateId: 'new-api-token-log' },
    },
    { action: 'clear', providerId: 'one' },
  ]);
  const crossSiteTemplate = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/template-selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ providerId: 'one', action: 'clear' }),
  });
  assert.equal(crossSiteTemplate.status, 403);

  const refresh = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(refresh.status, 202);
  assert.deepEqual(refreshAllCalls, [undefined]);

  const selectedRefresh = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerIds: ['one', 'missing', 'one'] }),
  });
  assert.equal(selectedRefresh.status, 202);
  assert.deepEqual(refreshAllCalls, [undefined, ['one']]);

  const providerRefresh = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: 'one' }),
  });
  assert.equal(providerRefresh.status, 202);
  assert.deepEqual(refreshProviderCalls, ['one']);

  const login = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', clientRef: 'chrome-ref-one' }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(loginCalls, [{ providerId: 'one', options: { clientRef: 'chrome-ref-one' } }]);

  const bindAccount = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/account-binding`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', clientRef: 'chrome-ref-one' }),
  });
  assert.equal(bindAccount.status, 200);
  assert.equal((await bindAccount.json()).provider.accountBinding.browser, 'Chrome');

  const clearAccount = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/account-binding`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'one', action: 'clear' }),
  });
  assert.equal(clearAccount.status, 200);
  assert.equal((await clearAccount.json()).provider.accountBinding, null);
  assert.deepEqual(bindingCalls, [
    { action: 'bind', providerId: 'one', options: { clientRef: 'chrome-ref-one' } },
    { action: 'clear', providerId: 'one' },
  ]);

  const unknownRefresh = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: 'missing' }),
  });
  assert.equal(unknownRefresh.status, 404);
  assert.deepEqual(await unknownRefresh.json(), { success: false, message: 'CCSwitch 中不存在这个 Codex 供应商' });
  assert.deepEqual(refreshProviderCalls, ['one']);

  const health = await fetch(`http://127.0.0.1:${server.boundPort}/v1/health`);
  assert.equal((await health.json()).service, 'codex-ccswitch-balance-hub');
  const providers = await fetch(`http://127.0.0.1:${server.boundPort}/v1/providers`);
  assert.equal((await providers.json()).providers[0].aliases[1], 'agentrouter');
  const balance = await fetch(`http://127.0.0.1:${server.boundPort}/usage/agentrouter`);
  const legacyPayload = await balance.json();
  assert.equal(legacyPayload.data.remaining, 8);
  assert.equal(legacyPayload.cache_only, true);
  assert.deepEqual(balanceCalls, []);

  const cachedBalance = await fetch(`http://127.0.0.1:${server.boundPort}/v1/balance/agentrouter`);
  const cachedPayload = await cachedBalance.json();
  assert.equal(cachedPayload.data.remaining, 8);
  assert.equal(cachedPayload.cache_only, true);
  const cachedBalances = await fetch(`http://127.0.0.1:${server.boundPort}/v1/balances`);
  assert.equal((await cachedBalances.json()).cache_only, true);
  assert.deepEqual(cachedBalanceCalls, ['agentrouter', 'agentrouter']);
  assert.deepEqual(balanceCalls, [], 'public cache reads must not trigger provider queries');

  const crossSite = await fetch(`http://127.0.0.1:${server.boundPort}/v1/balance/agentrouter`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('Hub uses the former bridge port as its stable local gateway', () => {
  const server = new HubServer({}, { token: 'test-token', openUrl() {} });
  assert.equal(server.port, 17891);
});

test('Hub accepts only literal loopback Host authorities for its bound port', async t => {
  const service = { getState: () => ({ providers: [], refreshing: false }) };
  const server = new HubServer(service, { port: 0, token: 'test-token', openUrl() {} });
  await server.start();
  t.after(() => server.close());

  assert.equal(isAllowedHubHost(`127.0.0.1:${server.boundPort}`, server.boundPort), true);
  assert.equal(isAllowedHubHost(`localhost:${server.boundPort}`, server.boundPort), true);
  assert.equal(isAllowedHubHost(`attacker.example:${server.boundPort}`, server.boundPort), false);

  const status = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: server.boundPort,
      path: '/v1/health',
      headers: { Host: `attacker.example:${server.boundPort}` },
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(status, 403);
});

test('Hub server can retry after its port is released', async t => {
  const blocker = http.createServer((_request, response) => response.end('occupied'));
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const port = blocker.address().port;
  const service = { getState: () => ({ providers: [], refreshing: false }) };
  const server = new HubServer(service, { port, token: 'test-token', openUrl() {} });
  t.after(async () => {
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    await server.close();
  });

  await assert.rejects(server.start(), error => error?.code === 'EADDRINUSE');
  await new Promise(resolve => blocker.close(resolve));

  const url = await server.start();
  assert.equal(server.boundPort, port);
  assert.equal(server.server?.listening, true);
  assert.equal(url, `http://127.0.0.1:${port}/hub/test-token`);
});

test('browser companion jobs and callbacks share the Hub server and token', async t => {
  const service = {
    getState: () => ({ version: 2, providers: [] }),
    listPublicProviders: () => [],
    queryBalance: () => Promise.resolve({ success: false }),
    queryAllBalances: () => Promise.resolve({ success: true, data: {} }),
    getBalance: () => ({ success: false, cache_only: true }),
    getAllBalances: () => ({ success: true, cache_only: true, data: {} }),
    listBrowserOrigins: () => ['https://relay.example'],
  };
  const broker = new BrowserCallbackBroker();
  const server = new HubServer(service, { port: 0, token: 'test-token', browserBroker: broker, openUrl() {} });
  await server.start();
  t.after(async () => { broker.close(); await server.close(); });
  const api = `http://127.0.0.1:${server.boundPort}/api/test-token`;
  const heartbeat = await fetch(`${api}/companion/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...companionHandshake(), clientId: 'edge-client-one', instanceId: 'edge-worker-one', browser: 'Edge', sessions: ['https://anyrouter.top'] }),
  });
  assert.equal(heartbeat.status, 200);
  assert.deepEqual((await heartbeat.json()).providerOrigins, ['https://relay.example']);

  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  const sessionQuery = new URLSearchParams({
    clientId: 'edge-client-one', instanceId: 'edge-worker-one', browser: 'Edge', version: '1',
    protocolVersion: String(companionHandshake().protocolVersion),
  });
  for (const capability of companionHandshake().capabilities) sessionQuery.append('capability', capability);
  sessionQuery.append('session', 'https://anyrouter.top');
  sessionQuery.append('session', 'https://chatgpt.com');
  const jobResponse = await fetch(`${api}/companion/job?${sessionQuery}`);
  const job = (await jobResponse.json()).job;
  assert.equal(broker.hasSession('https://chatgpt.com'), true);
  const callback = await fetch(`${api}/companion/result/${job.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'edge-client-one', instanceId: 'edge-worker-one', browser: 'Edge', claimToken: job.claimToken,
      ok: true, value: { status: 200, text: '{"success":true}' },
    }),
  });
  assert.equal(callback.status, 200);
  assert.deepEqual(await resultPromise, { status: 200, text: '{"success":true}' });
});

test('disconnecting a companion long poll removes its broker waiter immediately', async t => {
  const service = {
    getState: () => ({ version: 2, providers: [] }),
    listPublicProviders: () => [],
  };
  const broker = new BrowserCallbackBroker();
  const server = new HubServer(service, { port: 0, token: 'test-token', browserBroker: broker, openUrl() {} });
  await server.start();
  t.after(async () => { broker.close(); await server.close(); });

  const query = new URLSearchParams({
    clientId: 'edge-client-one', instanceId: 'edge-worker-one', browser: 'Edge', version: '1',
    protocolVersion: String(companionHandshake().protocolVersion),
  });
  for (const capability of companionHandshake().capabilities) query.append('capability', capability);
  const controller = new AbortController();
  const poll = fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/companion/job?${query}`, {
    signal: controller.signal,
  });
  for (let attempt = 0; attempt < 50 && broker.waiters.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(broker.waiters.length, 1);
  controller.abort();
  await assert.rejects(poll, error => error?.name === 'AbortError');
  for (let attempt = 0; attempt < 50 && broker.waiters.length !== 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(broker.waiters.length, 0);
});
