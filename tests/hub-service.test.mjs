import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hubItemToUsagePayload, HubService } from '../src/hub-service.mjs';

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
  assert.equal('auth' in state.providers[0], false);
  assert.equal('apiKey' in state.providers[0], false);
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
  assert.ok(service.listPublicProviders()[0].balanceUrl.endsWith('/agentrouter'));
  assert.equal(service.listPublicProviders()[0].queryMethod.requiresBrowser, true);
  const response = await service.queryBalance('agentrouter');
  assert.equal(response.success, true);
  assert.equal(response.data.remaining, 9);
  assert.equal(response.data.source, 'browser_session');
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
