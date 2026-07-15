import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserCallbackBroker } from '../src/browser-callback-broker.mjs';
import { getOrCreateHubToken, HubServer } from '../src/hub-server.mjs';

test('Hub path token persists across host restarts without becoming guessable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'hub-token');

  const first = getOrCreateHubToken(filename);
  const second = getOrCreateHubToken(filename);

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
});

test('Hub server protects its local page and API with an unguessable path token', async t => {
  let refreshAllCalls = 0;
  const balanceCalls = [];
  const service = {
    syncProviders() {},
    getState: () => ({ version: 2, providers: [] }),
    listPublicProviders: () => [{ id: 'one', name: 'Agent', aliases: ['one', 'agentrouter'] }],
    queryBalance(selector) {
      balanceCalls.push(selector);
      return Promise.resolve({ success: true, provider: 'one', data: { remaining: 9 } });
    },
    queryAllBalances: () => Promise.resolve({ success: true, data: {} }),
    refreshAll() { refreshAllCalls += 1; return Promise.resolve(); },
    refreshProvider: () => Promise.resolve(),
    openLogin: () => Promise.resolve({ id: 'one' }),
  };
  const server = new HubServer(service, { port: 0, token: 'test-token', openUrl() {} });
  await server.start();
  t.after(() => server.close());

  const page = await fetch(server.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /Balance Hub/);
  assert.match(html, /method-dialog/);
  assert.match(html, /action\('查看'/);
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
  assert.match(html, /需要同步/);
  assert.doesNotMatch(html, /已在现有浏览器中打开登录页/);
  assert.match(html, /无需重复配置/);
  assert.match(html, /nextRenderKey!==renderKey/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|access_token/);
  assert.equal(refreshAllCalls, 0, 'opening Hub must not refresh providers automatically');

  const state = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/state`);
  assert.deepEqual(await state.json(), {
    version: 2,
    providers: [],
    companion: { connected: false, clients: [], queuedJobs: 0, pendingJobs: 0 },
  });
  const rejected = await fetch(`http://127.0.0.1:${server.boundPort}/api/wrong/state`);
  assert.equal(rejected.status, 404);

  const refresh = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(refresh.status, 202);
  assert.ok(refreshAllCalls >= 1);

  const health = await fetch(`http://127.0.0.1:${server.boundPort}/v1/health`);
  assert.equal((await health.json()).service, 'codex-ccswitch-balance-hub');
  const providers = await fetch(`http://127.0.0.1:${server.boundPort}/v1/providers`);
  assert.equal((await providers.json()).providers[0].aliases[1], 'agentrouter');
  const balance = await fetch(`http://127.0.0.1:${server.boundPort}/usage/agentrouter`);
  assert.equal((await balance.json()).data.remaining, 9);
  assert.deepEqual(balanceCalls, ['agentrouter']);

  const crossSite = await fetch(`http://127.0.0.1:${server.boundPort}/v1/balance/agentrouter`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('Hub uses the former bridge port as its stable local gateway', () => {
  const server = new HubServer({}, { token: 'test-token', openUrl() {} });
  assert.equal(server.port, 17891);
});

test('browser companion jobs and callbacks share the Hub server and token', async t => {
  const service = {
    getState: () => ({ version: 2, providers: [] }),
    listPublicProviders: () => [],
    queryBalance: () => Promise.resolve({ success: false }),
    queryAllBalances: () => Promise.resolve({ success: true, data: {} }),
  };
  const broker = new BrowserCallbackBroker();
  const server = new HubServer(service, { port: 0, token: 'test-token', browserBroker: broker, openUrl() {} });
  await server.start();
  t.after(async () => { broker.close(); await server.close(); });
  const api = `http://127.0.0.1:${server.boundPort}/api/test-token`;
  const heartbeat = await fetch(`${api}/companion/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'edge-client-one', instanceId: 'edge-worker-one', browser: 'Edge', sessions: ['https://anyrouter.top'] }),
  });
  assert.equal(heartbeat.status, 200);

  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  const sessionQuery = new URLSearchParams({
    clientId: 'edge-client-one', instanceId: 'edge-worker-one', browser: 'Edge', version: '1',
  });
  sessionQuery.append('session', 'https://anyrouter.top');
  sessionQuery.append('session', 'https://chatgpt.com');
  const jobResponse = await fetch(`${api}/companion/job?${sessionQuery}`);
  const job = (await jobResponse.json()).job;
  assert.equal(broker.hasSession('https://chatgpt.com'), true);
  const callback = await fetch(`${api}/companion/result/${job.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, value: { status: 200, text: '{"success":true}' } }),
  });
  assert.equal(callback.status, 200);
  assert.deepEqual(await resultPromise, { status: 200, text: '{"success":true}' });
});
