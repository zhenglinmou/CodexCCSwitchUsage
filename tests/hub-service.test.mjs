import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hubItemToUsagePayload, HubService, safeHubMessage, sanitizeHubUsage } from '../src/hub-service.mjs';

function provider(id, name, current = false) {
  return { id, name, websiteUrl: 'https://example.com', isCurrent: current, usage: null, auth: {}, apiKey: '', apiBaseUrl: '', baseUrl: '' };
}

test('Hub state exposes safe provider fields and refreshes with bounded concurrency', async () => {
  const providers = [provider('one', 'DeepSeek', true), provider('two', 'PackyCode'), provider('three', '付费站')];
  let running = 0;
  let maximum = 0;
  const repository = { getAll: () => providers };
  const queryEngine = {
    async query(item) {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-14T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  };
  const service = new HubService(repository, queryEngine, { concurrency: 2 });

  await service.refreshAll();
  const state = service.getState();

  assert.equal(maximum, 2);
  assert.equal(state.providers.length, 3);
  assert.equal(state.providers[0].current, true);
  assert.equal(state.providers[0].status, 'ok');
  assert.equal(state.providers[0].usage.remaining, 9);
  assert.equal(state.providers[0].queryMethod.label, 'DeepSeek 官方余额 API');
  assert.equal(state.providers[0].queryMethod.authentication, 'Bearer API Key');
  assert.ok(Number.isFinite(state.providers[0].queryDurationMs));
  assert.ok(Number.isFinite(state.lastFullRefreshDurationMs));
  assert.equal('auth' in state.providers[0], false);
  assert.equal('apiKey' in state.providers[0], false);
});

test('Hub reserves a serial browser lane without increasing total refresh concurrency', async () => {
  const providers = [
    provider('direct-one', 'DeepSeek'),
    provider('browser-one', 'agentrouter'),
    provider('direct-two', 'PackyCode'),
    provider('browser-two', 'any的国内镜像'),
    provider('direct-three', '付费站'),
  ];
  let running = 0;
  let runningBrowser = 0;
  let runningDirect = 0;
  let maximum = 0;
  let maximumBrowser = 0;
  let maximumDirect = 0;
  const service = new HubService({ getAll: () => providers }, {
    async query(item) {
      const browser = /agentrouter|any/.test(item.name);
      running += 1;
      if (browser) runningBrowser += 1;
      else runningDirect += 1;
      maximum = Math.max(maximum, running);
      maximumBrowser = Math.max(maximumBrowser, runningBrowser);
      maximumDirect = Math.max(maximumDirect, runningDirect);
      await new Promise(resolve => setTimeout(resolve, 8));
      running -= 1;
      if (browser) runningBrowser -= 1;
      else runningDirect -= 1;
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-17T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  }, { concurrency: 3, browserConcurrency: 1 });

  await service.refreshAll();

  assert.equal(maximum, 3);
  assert.equal(maximumBrowser, 1);
  assert.equal(maximumDirect, 2);
});

test('Hub records provider query duration with an injectable monotonic clock', async () => {
  const item = provider('one', 'DeepSeek');
  let now = 1_000;
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      now = 1_037;
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-17T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  }, { now: () => now });

  const refreshed = await service.refreshProvider(item.id);

  assert.equal(refreshed.queryDurationMs, 37);
  assert.equal(service.getState().providers[0].queryDurationMs, 37);
});

test('Hub provider sync skips state rebuilds when the repository snapshot identity is unchanged', () => {
  let providers = [provider('one', 'DeepSeek', true)];
  const service = new HubService({ getAll: () => providers }, { query: async () => ({}) });
  const initialState = service.getState();
  const initialItem = service.items.get('one');
  assert.equal(initialState.revision, 1, 'the first snapshot must still initialize Hub state');

  const unchanged = service.syncProviders();

  assert.deepEqual(unchanged, { changed: false, providers });
  assert.equal(service.getState().revision, initialState.revision);
  assert.equal(service.items.get('one'), initialItem);

  providers = [provider('one', 'DeepSeek renamed', true), provider('two', 'PackyCode')];
  const changed = service.syncProviders();

  assert.deepEqual(changed, { changed: true, providers });
  assert.equal(service.getState().revision, initialState.revision + 1);
  assert.equal(service.getState().providers[0].name, 'DeepSeek renamed');
  assert.equal(service.getState().providers.length, 2);
});

test('removing a provider during refresh neither throws nor resurrects a partial item', async () => {
  let providers = [provider('one', 'DeepSeek', true)];
  let finishQuery;
  const service = new HubService({ getAll: () => providers }, {
    query: async () => new Promise(resolve => { finishQuery = resolve; }),
  });

  const refresh = service.refreshProvider('one');
  const balance = service.queryBalance('one');
  await Promise.resolve();
  providers = [];
  service.syncProviders();
  finishQuery({ source: 'test', message: 'obsolete result' });

  assert.equal(await refresh, null);
  assert.deepEqual(await balance, {
    success: false,
    provider: 'one',
    message: '供应商在余额查询期间已变更',
    login_required: false,
  });
  assert.deepEqual(service.getState().providers, []);
});

test('replacing provider configuration during refresh queues a query for the new snapshot', async () => {
  let providers = [provider('one', 'DeepSeek old', true)];
  const pendingQueries = [];
  const service = new HubService({ getAll: () => providers }, {
    query: async item => new Promise(resolve => pendingQueries.push({ item, resolve })),
  });

  const firstRefresh = service.refreshProvider('one');
  await Promise.resolve();
  providers = [provider('one', 'DeepSeek new', true)];
  service.syncProviders();
  const replacementRefresh = service.refreshProvider('one');
  pendingQueries[0].resolve({
    source: 'test',
    usage: {
      status: 'ok', providerId: 'one', providerName: 'DeepSeek old', used: 1, remaining: 9, total: 10,
      unit: 'USD', extra: '', updatedAt: '2026-07-17T00:00:00.000Z', refreshIntervalMinutes: 5,
    },
  });
  const obsoleteRefresh = await firstRefresh;
  assert.equal(obsoleteRefresh.name, 'DeepSeek new');
  assert.equal(obsoleteRefresh.usage, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingQueries.length, 2);
  assert.equal(pendingQueries[1].item.name, 'DeepSeek new');
  pendingQueries[1].resolve({
    source: 'test',
    usage: {
      status: 'ok', providerId: 'one', providerName: 'DeepSeek new', used: 2, remaining: 8, total: 10,
      unit: 'USD', extra: '', updatedAt: '2026-07-17T00:01:00.000Z', refreshIntervalMinutes: 5,
    },
  });

  const refreshed = await replacementRefresh;
  assert.equal(refreshed.name, 'DeepSeek new');
  assert.equal(refreshed.usage.providerName, 'DeepSeek new');
  assert.equal(refreshed.usage.remaining, 8);
});

test('Hub errors redact bearer tokens and preserve the last successful usage', async () => {
  const item = provider('one', 'AgentRouter');
  let fail = false;
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      if (fail) throw new Error('Authorization: Bearer secret-value');
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 2, remaining: 8, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-14T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.refreshProvider(item.id);
  fail = true;
  await service.refreshProvider(item.id);
  const state = service.getState().providers[0];

  assert.equal(state.status, 'degraded');
  assert.equal(state.usage.remaining, 8);
  assert.doesNotMatch(state.message, /secret-value/);
  assert.match(state.message, /\[redacted\]/);
});

test('Hub message sanitization is bounded, linear, and covers common credential labels', () => {
  const secret = 'pk_live_OFFLINE_TEST_1234567890';
  const jwt = `${'a'.repeat(18)}.${'b'.repeat(18)}.${'c'.repeat(18)}`;
  const messages = [
    `api_key=${secret}`,
    `OPENAI_API_KEY: ${secret}`,
    `X-Api-Key=${secret}`,
    `access_token=${secret}`,
    `token=${secret}`,
    `Authorization: Bearer ${secret}`,
    `standalone ${jwt}`,
  ];

  for (const message of messages) {
    const sanitized = safeHubMessage(message);
    assert.doesNotMatch(sanitized, new RegExp(secret));
    assert.doesNotMatch(sanitized, new RegExp(jwt.replaceAll('.', '\\.')));
    assert.match(sanitized, /\[redacted(?:-jwt)?\]/);
  }

  const bounded = safeHubMessage('x'.repeat(320_000));
  assert.ok(bounded.length < 8_250);
  assert.match(bounded, /\[truncated\]$/);

  const usage = sanitizeHubUsage({
    status: 'ok', providerName: 'Offline', extra: `api_key=${secret}`,
    used: 1, remaining: 2, total: 3, unit: 'USD',
  });
  assert.doesNotMatch(usage.extra, new RegExp(secret));
  assert.match(usage.extra, /\[redacted\]/);
});

test('Hub restores cached browser failures as degraded usage instead of stale login state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-hub-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'hub-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    providers: [{
      id: 'one',
      status: 'degraded',
      source: 'browser_session',
      message: '显示上次成功余额；浏览器伴侣连接后将自动重试（现有浏览器尚未登录该网站）',
      usage: {
        providerName: 'AnyRouter', used: 2, remaining: 8, total: 10, unit: 'USD', extra: '',
        periodLabel: '', hideTotal: false, refreshIntervalMinutes: 5, updatedAt: '2026-07-15T00:00:00.000Z',
      },
    }],
  }), 'utf8');

  const service = new HubService({ getAll: () => [provider('one', 'any的国内镜像')] }, { query: async () => ({}) }, { cachePath });
  const item = service.getState().providers[0];

  assert.equal(item.status, 'degraded');
  assert.equal(item.usage.remaining, 8);
  assert.equal(item.sessionSyncRequired, true);
  assert.match(item.message, /同步现有会话/);
  assert.doesNotMatch(item.message, /自动重试/);
});

test('Hub does not rewrite a freshly confirmed login failure during a live provider sync', async () => {
  const item = provider('one', 'any的国内镜像');
  let loginRequired = false;
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      if (loginRequired) return { source: 'browser_session', loginRequired: true, sessionSyncRequired: true, message: 'not logged in' };
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 2, remaining: 8, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-15T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.refreshProvider(item.id);
  loginRequired = true;
  await service.refreshProvider(item.id);
  service.syncProviders();

  assert.equal(service.getState().providers[0].status, 'login-required');
  assert.equal(service.getState().providers[0].sessionSyncRequired, true);
});

test('a successful AnyRouter account query updates both the domestic mirror and foreign provider cards', async () => {
  const domestic = {
    ...provider('domestic', 'any的国内镜像'),
    apiBaseUrl: 'https://domestic-mirror.example/v1',
  };
  const foreign = {
    ...provider('foreign', 'any的国外我自己的'),
    apiBaseUrl: 'https://anyrouter.top/v1',
  };
  const service = new HubService({ getAll: () => [domestic, foreign] }, {
    async query(item) {
      if (item.id === domestic.id) {
        return {
          source: 'browser_session',
          loginRequired: true,
          websiteLoginRequired: true,
          message: 'Failed to fetch',
        };
      }
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: 'default', used: 42.5, remaining: 507.5, total: 550,
          unit: 'USD', extra: '', updatedAt: '2026-07-18T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.refreshProvider(domestic.id);
  assert.equal(service.items.get(domestic.id).status, 'login-required');

  await service.refreshProvider(foreign.id);
  const state = service.getState().providers;
  const domesticState = state.find(item => item.id === domestic.id);
  const foreignState = state.find(item => item.id === foreign.id);

  assert.equal(domesticState.status, 'ok');
  assert.equal(domesticState.websiteLoginRequired, false);
  assert.equal(domesticState.message, '');
  assert.deepEqual(domesticState.usage, foreignState.usage);
  assert.equal(domesticState.usage.remaining, 507.5);
  assert.equal(service.findProvider(domestic.id).apiBaseUrl, 'https://domestic-mirror.example/v1');
});

test('Hub one-time browser session sync immediately retries the provider', async () => {
  const item = provider('any', 'any的国外我自己的');
  let queryCalls = 0;
  const service = new HubService({ getAll: () => [item] }, {
    async openLogin() {
      return { synced: true, opened: false, origin: 'https://anyrouter.top' };
    },
    async query() {
      queryCalls += 1;
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 2, remaining: 8, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-15T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  assert.equal(service.getState().providers[0].sessionSyncSupported, true);
  const result = await service.openLogin(item.id);
  assert.equal(queryCalls, 1);
  assert.equal(result.status, 'ok');
});

test('Hub preserves an explicit website-authentication action until the user refreshes successfully', async () => {
  const item = provider('any', 'any的国外我自己的');
  const service = new HubService({ getAll: () => [item] }, {
    async openLogin() { return { synced: false, opened: true, origin: 'https://anyrouter.top' }; },
    async query() { return { source: 'browser_session', loginRequired: true, websiteLoginRequired: true, message: '需要官网认证' }; },
  });

  await service.refreshProvider(item.id);
  assert.equal(service.getState().providers[0].websiteLoginRequired, true);
  const opened = await service.openLogin(item.id);
  assert.equal(opened.websiteLoginRequired, true);
  assert.match(opened.message, /登录页/);
});

test('Hub resolves stable aliases and exposes normalized balance responses', async () => {
  const item = provider('provider-one', 'agentrouter', true);
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: 'AgentRouter', used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-15T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  assert.equal(service.findProvider('agentrouter').id, item.id);
  assert.ok(service.listPublicProviders()[0].balanceUrl.endsWith('/provider-one'));
  assert.equal(service.listPublicProviders()[0].queryMethod.requiresBrowser, true);
  assert.equal(service.getState().providers[0].loginUrl, 'https://agentrouter.org/login');
  assert.equal(service.listPublicProviders()[0].loginUrl, 'https://agentrouter.org/login');
  const response = await service.queryBalance('agentrouter');
  assert.equal(response.success, true);
  assert.equal(response.data.remaining, 9);
  assert.equal(response.data.source, 'browser_session');
});

test('public balance URLs remain unique when provider aliases collide', () => {
  const providers = [
    provider('deepseek-one', 'DeepSeek'),
    provider('deepseek-two', 'DeepSeek copy'),
  ];
  const service = new HubService({ getAll: () => providers }, { query: async () => ({}) });
  const listed = service.listPublicProviders();

  assert.deepEqual(listed.map(item => item.balanceUrl), [
    '/v1/balance/deepseek-one',
    '/v1/balance/deepseek-two',
  ]);
  assert.equal(service.findProvider('deepseek').id, 'deepseek-one', 'the optional alias may remain ambiguous');
  assert.equal(service.findProvider('deepseek-two').id, 'deepseek-two', 'the advertised URL must use the unique id');
});

test('Codex footer payload is derived from Hub state and preserves cached usage on login errors', () => {
  const current = provider('one', 'AgentRouter', true);
  const payload = hubItemToUsagePayload(current, {
    status: 'login-required',
    message: '需要网页登录',
    usage: {
      providerName: 'AgentRouter', used: 2, remaining: 8, total: 10, unit: 'USD', extra: '',
      periodLabel: '', hideTotal: false, refreshIntervalMinutes: 5, updatedAt: '2026-07-15T00:00:00.000Z',
    },
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.remaining, 8);
  assert.equal(payload.queryError, '需要网页登录');
});
