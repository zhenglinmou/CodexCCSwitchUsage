import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  hubItemToUsagePayload,
  HubService,
  providerConfigurationFingerprint,
  safeHubMessage,
  sanitizeHubUsage,
} from '../src/hub-service.mjs';
import { ProviderQueryEngine } from '../src/hub-provider-adapters.mjs';
import { ProviderTemplateStore } from '../src/provider-templates.mjs';

function provider(id, name, current = false) {
  const normalized = String(name || '').toLowerCase();
  let apiBaseUrl = '';
  if (normalized.includes('deepseek')) apiBaseUrl = 'https://api.deepseek.com';
  else if (normalized.includes('packy')) apiBaseUrl = 'https://www.packyapi.com/v1';
  else if (normalized.includes('agentrouter')) apiBaseUrl = 'https://agentrouter.org';
  else if (normalized.includes('any的国内')) apiBaseUrl = 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1';
  else if (normalized.includes('any')) apiBaseUrl = 'https://anyrouter.top/v1';
  else if (normalized.includes('付费站')) apiBaseUrl = 'https://rawchat.cn/codex';
  return { id, name, websiteUrl: 'https://example.com', isCurrent: current, usage: null, auth: {}, apiKey: '', apiBaseUrl, baseUrl: apiBaseUrl };
}

test('provider fingerprints include built-in balance and request template selections', () => {
  const item = provider('one', '未识别中转');
  const baseline = {
    balanceTemplateId: 'api-health-local',
    balanceSource: 'builtin',
    requestUsageTemplateId: 'ccswitch-local',
    requestUsageSource: 'builtin',
  };

  assert.notEqual(
    providerConfigurationFingerprint(item, baseline),
    providerConfigurationFingerprint(item, { ...baseline, balanceTemplateId: 'new-api-key-quota' }),
  );
  assert.notEqual(
    providerConfigurationFingerprint(item, baseline),
    providerConfigurationFingerprint(item, { ...baseline, requestUsageTemplateId: 'new-api-token-log' }),
  );
});

test('provider fingerprints ignore the legacy usage script payload in v3', () => {
  const base = provider('legacy', '未识别中转');
  const first = providerConfigurationFingerprint({
    ...base,
    usage: { enabled: true, script: 'old script', noisy: 'a'.repeat(20_000) },
  });
  const second = providerConfigurationFingerprint({
    ...base,
    usage: { enabled: false, script: 'new script', noisy: 'b'.repeat(20_000) },
  });

  assert.equal(first, second);
});

test('Hub provider snapshot changes clear obsolete request status origins', () => {
  let providers = [provider('one', 'DeepSeek', true)];
  let clearCalls = 0;
  const service = new HubService({ getAll: () => providers }, { async query() { return {}; } }, {
    requestUsageEngine: { clearStatusCache() { clearCalls += 1; } },
  });
  const initialClearCalls = clearCalls;

  providers = [...providers, provider('two', 'PackyCode')];
  service.syncProviders();

  assert.equal(clearCalls, initialClearCalls + 1);
});

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
  assert.equal(state.providers[0].queryMethod.authentication, 'Bearer API Key；无需官网登录');
  assert.ok(Number.isFinite(state.providers[0].queryDurationMs));
  assert.ok(Number.isFinite(state.lastFullRefreshDurationMs));
  assert.equal('auth' in state.providers[0], false);
  assert.equal('apiKey' in state.providers[0], false);
});

test('Hub reuses derived public state and browser origins until its provider snapshot changes', () => {
  let providers = [provider('one', 'AgentRouter', true)];
  const service = new HubService({ getAll: () => providers }, { async query() { return {}; } });

  const firstState = service.getState();
  const secondState = service.getState();
  const firstOrigins = service.listBrowserOrigins();
  const secondOrigins = service.listBrowserOrigins();

  assert.strictEqual(secondState.providers, firstState.providers);
  assert.strictEqual(secondOrigins, firstOrigins);
  assert.deepEqual(service.getSummary(), { providers: 1, refreshing: false });

  providers = [...providers, provider('two', 'DeepSeek')];
  service.syncProviders();

  const changedState = service.getState();
  const changedOrigins = service.listBrowserOrigins();
  assert.notStrictEqual(changedState.providers, firstState.providers);
  assert.notStrictEqual(changedOrigins, firstOrigins);
  assert.equal(service.findProvider('TWO')?.id, 'two');
  assert.deepEqual(service.getSummary(), { providers: 2, refreshing: false });
});

test('Hub full refresh can target only active workspace providers', async () => {
  const providers = [provider('one', 'DeepSeek', true), provider('two', 'PackyCode')];
  const queried = [];
  const service = new HubService({ getAll: () => providers }, {
    async query(item) {
      queried.push(item.id);
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-26T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.refreshAll(['one', 'missing', 'one']);

  assert.deepEqual(queried, ['one']);
  assert.equal(service.getState().providers.find(item => item.id === 'one').status, 'ok');
  assert.equal(service.getState().providers.find(item => item.id === 'two').status, 'idle');
});

test('a full refresh queued behind a scoped refresh still covers every provider once', async () => {
  const providers = [provider('one', 'DeepSeek', true), provider('two', 'PackyCode'), provider('three', '付费站')];
  const queried = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const service = new HubService({ getAll: () => providers }, {
    async query(item) {
      queried.push(item.id);
      if (item.id === 'one') {
        markFirstStarted();
        await firstGate;
      }
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-28T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  }, { concurrency: 2 });

  const scoped = service.refreshAll(['one']);
  await firstStarted;
  const full = service.refreshAll();
  releaseFirst();
  await Promise.all([scoped, full]);

  assert.deepEqual(queried.sort(), ['one', 'three', 'two']);
  assert.ok(service.getState().lastFullRefreshAt);
  assert.equal(service.getState().providers.every(item => item.status === 'ok'), true);
});

test('Hub preserves an adapter-specific message for degraded local usage', async () => {
  const item = provider('muyuan', '君的公益');
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      return {
        source: 'muyuan_local_usage',
        degraded: true,
        message: '君的公益远端查询失败，显示本地已用估算',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 10.61, remaining: null, total: null,
          unit: 'USD', extra: '请求次数：102', updatedAt: '2026-07-23T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  const refreshed = await service.refreshProvider(item.id);

  assert.equal(refreshed.status, 'degraded');
  assert.equal(refreshed.message, '君的公益远端查询失败，显示本地已用估算');
  assert.equal(refreshed.usage.used, 10.61);
});

test('request usage prefers exact provider logs without reading CCSwitch fallback rows', async () => {
  const item = provider('remote', 'agentrouter');
  let localReads = 0;
  let requestOptions;
  const service = new HubService({
    getAll: () => [item],
    getCredentialAppTypes: () => ['claude-desktop', 'codex'],
    getRecentRequests() {
      localReads += 1;
      return [];
    },
  }, { async query() { return {}; } }, {
    requestUsageEngine: {
      async query(_provider, options) {
        requestOptions = options;
        return {
          success: true,
          supported: true,
          providerId: item.id,
          providerName: item.name,
          source: 'provider_log',
          billing: { exact: true, unit: 'USD' },
          items: [{ totalCost: 0.25, costExact: true, costSource: 'provider_log' }],
        };
      },
    },
  });

  const result = await service.queryRequestUsage(item.id, { limit: 10 });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_log');
  assert.equal(result.fallback, false);
  assert.equal(result.preciseCostAvailable, true);
  assert.equal(result.appType, 'codex');
  assert.equal(result.credentialSharedAcrossApps, true);
  const { getLocalRequestRows, ...staticRequestOptions } = requestOptions;
  assert.equal(typeof getLocalRequestRows, 'function');
  assert.deepEqual(staticRequestOptions, { limit: 10, appType: 'codex', strictAppType: true });
  assert.equal(localReads, 0);
});

test('request usage propagates caller cancellation without reading fallback rows', async () => {
  const item = provider('cancelled-requests', 'agentrouter');
  let localReads = 0;
  let started;
  const queryStarted = new Promise(resolve => { started = resolve; });
  const service = new HubService({
    getAll: () => [item],
    getRecentRequests() {
      localReads += 1;
      return [];
    },
  }, { async query() { return {}; } }, {
    requestUsageEngine: {
      async query(_provider, options) {
        started();
        await new Promise((_resolve, reject) => {
          const abort = () => reject(options.signal.reason || new Error('cancelled'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      },
    },
  });
  const controller = new AbortController();
  const query = service.queryRequestUsage(item.id, { limit: 10, signal: controller.signal });
  await queryStarted;

  controller.abort(new Error('recent requests closed'));

  await assert.rejects(query, /recent requests closed/);
  assert.equal(localReads, 0);
});

test('AnyRouter domestic mirrors reuse the same-key canonical provider request logs', async () => {
  const domestic = {
    ...provider('domestic-logs', 'any的国内镜像'),
    apiKey: 'same-anyrouter-key',
    apiBaseUrl: 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1',
  };
  const foreign = {
    ...provider('foreign-logs', 'any的国外我自己的'),
    apiKey: 'same-anyrouter-key',
    apiBaseUrl: 'https://anyrouter.top/v1',
  };
  const localLookups = [];
  let queriedProvider = null;
  const service = new HubService({
    getAll: () => [domestic, foreign],
    getCredentialAppTypes: () => ['codex'],
    getRecentRequests(providerId, limit) {
      localLookups.push({ providerId, limit });
      return providerId === foreign.id
        ? [{ createdAt: '2026-07-28T16:33:07.000Z', model: 'gpt-5.6-sol', inputTokens: 30_845, outputTokens: 40, statusCode: 200 }]
        : [];
    },
  }, { async query() { return {}; } }, {
    requestUsageEngine: {
      async query(item, options) {
        queriedProvider = item;
        const rows = options.getLocalRequestRows(10);
        return {
          success: true,
          supported: true,
          providerId: item.id,
          providerName: item.name,
          source: 'provider_account_log',
          billing: { exact: true, unit: 'USD' },
          items: rows,
        };
      },
    },
  });

  const result = await service.queryRequestUsage(domestic.id, { limit: 10 });

  assert.equal(queriedProvider.id, foreign.id);
  assert.deepEqual(localLookups, [{ providerId: foreign.id, limit: 10 }]);
  assert.equal(result.providerId, domestic.id);
  assert.equal(result.providerName, domestic.name);
  assert.equal(result.items.length, 1);
});

test('request usage falls back to marked CCSwitch estimates when provider logs are unavailable', async () => {
  const item = provider('packy', 'PackyCode');
  let localLookup;
  const service = new HubService({
    getAll: () => [item],
    getRecentRequests(providerId, limit) {
      localLookup = { providerId, limit };
      return [{
        model: 'gpt-5.6-sol',
        requestModel: 'gpt-5.6-sol',
        inputTokens: 120,
        outputTokens: 8,
        cacheReadTokens: 4,
        cacheCreationTokens: 2,
        totalCostUsd: 0.25,
        latencyMs: 1500,
        firstTokenMs: 300,
        statusCode: 200,
        createdAt: '2026-07-25T01:02:03.000Z',
      }];
    },
  }, { async query() { return {}; } }, {
    now: () => Date.parse('2026-07-25T02:00:00.000Z'),
    requestUsageEngine: {
      async query() {
        return {
          success: false,
          supported: true,
          providerId: item.id,
          providerName: item.name,
          source: 'new-api-token-log',
          interface: { supported: true, adapter: 'new-api-token-log' },
          items: [],
          httpStatus: 200,
          errorType: 'provider',
          message: 'record not found',
        };
      },
    },
  });

  const result = await service.queryRequestUsage(item.id, { limit: 10 });

  assert.deepEqual(localLookup, { providerId: item.id, limit: 10 });
  assert.equal(result.success, true);
  assert.equal(result.source, 'ccswitch_local');
  assert.equal(result.remoteSource, 'new-api-token-log');
  assert.equal(result.fallback, true);
  assert.equal(result.degraded, true);
  assert.equal(result.preciseCostAvailable, false);
  assert.equal(result.billing.exact, false);
  assert.equal(result.billing.multiplier, 1);
  assert.match(result.message, /record not found/);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].totalCost, 0.25);
  assert.equal(result.items[0].costExact, false);
  assert.equal(result.items[0].costSource, 'ccswitch_local');
  assert.equal(result.items[0].rawQuota, null);
});

test('request usage shares one lazy local read between account-log detection and CCSwitch fallback', async () => {
  const item = provider('relay', 'agentrouter');
  const localRows = [{
    model: 'gpt-5.6-sol',
    requestModel: 'gpt-5.6-sol',
    inputTokens: 120,
    outputTokens: 8,
    cacheReadTokens: 4,
    cacheCreationTokens: 2,
    totalCostUsd: 0.25,
    latencyMs: 1500,
    firstTokenMs: 300,
    statusCode: 200,
    createdAt: '2026-07-25T01:02:03.000Z',
  }];
  const localLimits = [];
  const service = new HubService({
    getAll: () => [item],
    getRecentRequests(providerId, limit) {
      assert.equal(providerId, item.id);
      localLimits.push(limit);
      return localRows;
    },
  }, { async query() { return {}; } }, {
    requestUsageEngine: {
      async query(_provider, options) {
        assert.equal(options.getLocalRequestRows(50), localRows);
        assert.equal(options.getLocalRequestRows(10), localRows);
        return {
          success: false,
          supported: true,
          providerId: item.id,
          providerName: item.name,
          source: 'new-api-token-log',
          interface: { supported: true, adapter: 'new-api-token-log' },
          items: [],
          errorType: 'account_scope',
          message: '浏览器账户日志无法归属到当前供应商 API Key',
        };
      },
    },
  });

  const result = await service.queryRequestUsage(item.id, { limit: 10 });

  assert.deepEqual(localLimits, [50]);
  assert.equal(result.success, true);
  assert.equal(result.source, 'ccswitch_local');
  assert.equal(result.remoteErrorType, 'account_scope');
  assert.equal(result.items.length, 1);
});

test('Hub persists independent manual templates and routes later queries through them', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-hub-templates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const item = {
    ...provider('relay', '新中转'),
    websiteUrl: 'https://relay.example',
    apiBaseUrl: 'https://relay.example/v1',
    baseUrl: 'https://relay.example/v1',
    apiKey: 'private-relay-key',
  };
  const balanceCalls = [];
  const requestCalls = [];
  const service = new HubService({
    getAll: () => [item],
    getCredentialAppTypes: () => ['codex'],
  }, {
    async query(_provider, options) {
      balanceCalls.push(options);
      return {
        source: 'new_api_key',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-26T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  }, {
    templateStore: new ProviderTemplateStore(path.join(directory, 'bindings.json')),
    requestUsageEngine: {
      clearStatusCache() {},
      async query(_provider, options) {
        requestCalls.push(options);
        return { success: true, source: 'provider_log', billing: { exact: true }, items: [] };
      },
    },
  });

  assert.deepEqual(service.getState().providers[0].templateSelection, {
    balanceTemplateId: 'api-health-local',
    balanceSource: 'builtin',
    requestUsageTemplateId: 'ccswitch-local',
    requestUsageSource: 'builtin',
    updatedAt: '',
  });
  const saved = service.saveTemplateSelection(item.id, {
    balanceTemplateId: 'new-api-key-quota',
    requestUsageTemplateId: 'new-api-token-log',
  });
  assert.equal(saved.templateSelection.balanceSource, 'manual');
  assert.equal(saved.templateSelection.requestUsageSource, 'manual');
  assert.equal(saved.queryMethod.requestUrl, 'https://relay.example/api/usage/token/');

  await service.refreshProvider(item.id);
  await service.queryRequestUsage(item.id);
  assert.equal(balanceCalls.at(-1).balanceTemplateId, 'new-api-key-quota');
  assert.equal(requestCalls.at(-1).requestUsageTemplateId, 'new-api-token-log');
  assert.deepEqual(service.listBrowserOrigins(), ['https://relay.example']);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'bindings.json'), 'utf8'), /private-relay-key/);

  const cleared = service.clearTemplateSelection(item.id);
  assert.equal(cleared.templateSelection.balanceSource, 'builtin');
  assert.equal(cleared.templateSelection.requestUsageSource, 'builtin');
});

test('Hub template detection stops at the first validated response shape', async () => {
  const item = {
    ...provider('relay-probe', '待识别中转'),
    apiBaseUrl: 'https://probe.example/v1',
    baseUrl: 'https://probe.example/v1',
    apiKey: 'probe-private-key',
  };
  const balanceCalls = [];
  const service = new HubService({
    getAll: () => [item],
    getRecentRequests: () => [],
  }, {
    async query(_provider, options) {
      balanceCalls.push(options.balanceTemplateId);
      if (options.balanceTemplateId !== 'packy-balance') return { message: 'shape mismatch' };
      return {
        source: 'provider_api',
        usage: { providerName: item.name, remaining: 7, used: 3, total: 10, unit: 'USD' },
      };
    },
  }, {
    requestUsageEngine: {
      async query(_provider, options) {
        assert.equal(options.requestUsageTemplateId, 'new-api-token-log');
        return { success: true, source: 'provider_log', requestCount: 0, billing: { exact: true, unit: 'USD' } };
      },
    },
  });

  const result = await service.probeTemplates(item.id);
  assert.equal(result.balance.recommendedTemplateId, 'packy-balance');
  assert.deepEqual(balanceCalls, ['packy-balance']);
  assert.equal(result.requestUsage.recommendedTemplateId, 'new-api-token-log');
  assert.equal(result.requestUsage.results[0].preview.requestCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /probe-private-key/);
});

test('Hub probes the built-in OpenAI official session Token template', async () => {
  const item = {
    ...provider('openai-owned', 'OpenAI Official-我自己的'),
    websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'official-account-one' } },
  };
  const requestCalls = [];
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query() {
      return {
        source: 'openai_wham',
        usage: { providerName: item.name, remaining: 80, used: 20, total: 100, unit: 'percent' },
      };
    },
  }, {
    requestUsageEngine: {
      async query(_provider, options) {
        requestCalls.push(options);
        return {
          success: true,
          source: 'openai_codex_session',
          requestCount: 4,
          degraded: true,
          message: '官方 Token 精确；ChatGPT 套餐不提供逐请求金额',
          billing: { available: false, exact: false, unit: 'subscription' },
          items: [],
        };
      },
    },
  });

  const state = service.getState().providers[0];
  assert.equal(state.templateSelection.requestUsageTemplateId, 'openai-codex-session');
  assert.equal(state.templateSelection.requestUsageSource, 'builtin');
  const result = await service.probeTemplates(item.id);
  assert.equal(result.requestUsage.recommendedTemplateId, 'openai-codex-session');
  assert.equal(result.requestUsage.results[0].status, 'success');
  assert.equal(result.requestUsage.results[0].preview.requestCount, 4);
  assert.equal(Object.hasOwn(requestCalls[0], 'requestUsageTemplateId'), false);
});

test('Hub overlaps slow template probes while preserving recommendation priority', async () => {
  const item = {
    ...provider('parallel-probe', '并行识别中转'),
    apiBaseUrl: 'https://parallel.example/v1',
    baseUrl: 'https://parallel.example/v1',
    apiKey: 'parallel-private-key',
  };
  let running = 0;
  let maximum = 0;
  let requestUsageOverlapped = false;
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query(_provider, options) {
      running += 1;
      maximum = Math.max(maximum, running);
      try {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (options.balanceTemplateId !== 'window-balance') return { message: 'shape mismatch' };
        return {
          source: 'provider_api',
          usage: { providerName: item.name, remaining: 7, used: 3, total: 10, unit: 'USD' },
        };
      } finally {
        running -= 1;
      }
    },
  }, {
    templateProbeSpeculationDelayMs: 1,
    requestUsageEngine: {
      async query() {
        requestUsageOverlapped = running > 0;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true, source: 'provider_log', requestCount: 0, billing: { exact: true, unit: 'USD' } };
      },
    },
  });

  const result = await service.probeTemplates(item.id);

  assert.ok(maximum > 1, 'slow balance schemas should be tested concurrently');
  assert.equal(requestUsageOverlapped, true, 'request usage detection should overlap balance detection');
  assert.equal(result.balance.recommendedTemplateId, 'window-balance');
  assert.deepEqual(result.balance.results.map(entry => entry.templateId), [
    'packy-balance',
    'new-api-key-quota',
    'deepseek-balance',
    'window-balance',
  ]);
});

test('Hub aborts speculative shared network probes after a higher-priority template wins', async () => {
  const item = {
    ...provider('cancel-speculative-probe', '新中转'),
    apiBaseUrl: 'https://cancel-probe.example/v1',
    baseUrl: 'https://cancel-probe.example/v1',
    apiKey: 'cancel-private-key',
  };
  const providers = [item];
  let slowStarts = 0;
  let slowAborts = 0;
  const queryEngine = new ProviderQueryEngine({ getAll: () => providers }, { isConnected: () => false }, {
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/usage/token/') {
        return new Response(JSON.stringify({
          code: true,
          data: {
            total_available: 10_000_000,
            total_used: 2_000_000,
            quota_reset_period: 'daily',
            unlimited_quota: true,
          },
        }), { status: 200 });
      }
      if (pathname === '/api/status') {
        return new Response(JSON.stringify({
          success: true,
          data: { quota_display_type: 'USD', quota_per_unit: 500_000 },
        }), { status: 200 });
      }
      if (pathname.endsWith('/user/balance')) {
        slowStarts += 1;
        return new Promise((resolve, reject) => {
          const abort = () => {
            slowAborts += 1;
            reject(options.signal.reason || new Error('aborted'));
          };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
      return new Response('{}', { status: 404 });
    },
  });
  const service = new HubService({ getAll: () => providers, getRecentRequests: () => [] }, queryEngine, {
    templateProbeSpeculationDelayMs: 0,
    requestUsageEngine: { async query() { return { success: false, message: 'not supported' }; } },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, 'packy-balance');
  assert.ok(slowStarts >= 1);
  assert.equal(slowAborts, slowStarts);
});

test('Hub automatic detection is not biased by a stale manual balance binding', async () => {
  const item = {
    ...provider('manual-browser-probe', '曾经手动绑定的中转'),
    apiBaseUrl: 'https://manual-probe.example/v1',
    baseUrl: 'https://manual-probe.example/v1',
    apiKey: 'manual-probe-private-key',
  };
  const balanceCalls = [];
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query(_provider, options) {
      balanceCalls.push(options.balanceTemplateId);
      if (!['packy-balance', 'new-api-browser-account'].includes(options.balanceTemplateId)) {
        return { message: 'shape mismatch' };
      }
      return {
        source: 'provider_api',
        usage: { providerName: item.name, remaining: 7, used: 3, total: 10, unit: 'USD' },
      };
    },
  }, {
    templateStore: {
      get() {
        return { balanceTemplateId: 'new-api-browser-account' };
      },
    },
    requestUsageEngine: { async query() { return { success: false, message: 'not supported' }; } },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, 'packy-balance');
  assert.deepEqual(balanceCalls, ['packy-balance']);
});

test('Hub checks key-scoped New API capabilities before a built-in browser-account default', async () => {
  const item = {
    ...provider('browser-default-probe', 'any的国外我自己的'),
    apiBaseUrl: 'https://anyrouter.top/v1',
    baseUrl: 'https://anyrouter.top/v1',
    apiKey: 'browser-default-private-key',
  };
  const balanceCalls = [];
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query(_provider, options) {
      const templateId = options.balanceTemplateId || 'new-api-browser-account';
      balanceCalls.push(templateId);
      if (!['packy-balance', 'new-api-browser-account'].includes(templateId)) {
        return { message: 'shape mismatch' };
      }
      return {
        source: templateId === 'packy-balance' ? 'packy_api_key' : 'new_api_account',
        usage: { providerName: item.name, remaining: 7, used: 3, total: 10, unit: 'USD' },
      };
    },
  }, {
    requestUsageEngine: { async query() { return { success: false, message: 'not supported' }; } },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, 'packy-balance');
  assert.deepEqual(balanceCalls, ['packy-balance']);
});

test('Hub recommends a schema-validated unlimited New API template even when browser login is still required', async () => {
  const item = {
    ...provider('unlimited-auto-probe', '新无限额度中转'),
    apiBaseUrl: 'https://unlimited-probe.example/v1',
    baseUrl: 'https://unlimited-probe.example/v1',
    apiKey: 'unlimited-private-key',
  };
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query(_provider, options) {
      if (options.balanceTemplateId !== 'new-api-key-quota') return { message: 'shape mismatch' };
      return {
        source: 'new_api_account',
        schemaValidated: true,
        loginRequired: true,
        sessionSyncRequired: true,
        message: 'API Key 为无限额度；需要同步官网登录态读取账户总额度',
      };
    },
  }, {
    requestUsageEngine: { async query() { return { success: false, message: 'not supported' }; } },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, 'new-api-key-quota');
  assert.equal(result.balance.fallbackTemplateId, '');
  assert.equal(result.balance.results.find(entry => entry.templateId === 'new-api-key-quota').status, 'needs-action');
});

test('Hub checks the more specific New API reset-period capability before a standard built-in template', async () => {
  const item = {
    ...provider('mofa-specific-probe', '魔方公益站'),
    apiBaseUrl: 'https://mofas.one/v1',
    baseUrl: 'https://mofas.one/v1',
  };
  const balanceCalls = [];
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query(_provider, options) {
      balanceCalls.push(options.balanceTemplateId || 'builtin');
      if (options.balanceTemplateId !== 'packy-balance') return { message: 'standard response' };
      return {
        source: 'provider_api',
        usage: { providerName: item.name, remaining: 7, used: 3, total: 10, unit: 'USD' },
      };
    },
  }, {
    requestUsageEngine: { async query() { return { success: false, message: 'not supported' }; } },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, 'packy-balance');
  assert.deepEqual(balanceCalls, ['packy-balance']);
});

test('Hub advertises the local health fallback only after probing it successfully', async () => {
  const item = {
    ...provider('fallback-probe', '未知中转'),
    apiBaseUrl: 'https://fallback.example/v1',
    baseUrl: 'https://fallback.example/v1',
    apiKey: 'fallback-private-key',
  };
  const calls = [];
  const service = new HubService({
    getAll: () => [item],
    getRecentRequests: () => [],
  }, {
    async query(_provider, options) {
      calls.push(options.balanceTemplateId);
      if (options.balanceTemplateId !== 'api-health-local') return { message: 'shape mismatch' };
      return {
        source: 'api_health_and_local_usage',
        usage: { providerName: item.name, remaining: null, used: 3, total: null, unit: 'USD' },
      };
    },
  }, {
    requestUsageEngine: { async query() { return { success: false, message: 'not supported' }; } },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, '');
  assert.equal(result.balance.fallbackTemplateId, 'api-health-local');
  assert.equal(result.balance.results.at(-1).templateId, 'api-health-local');
  assert.equal(result.balance.results.at(-1).status, 'success');
  assert.deepEqual(calls, [
    'packy-balance',
    'new-api-key-quota',
    'deepseek-balance',
    'window-balance',
    'new-api-browser-account',
    'api-health-local',
  ]);
});

test('Hub does not advertise a local health fallback that failed its probe', async () => {
  const item = {
    ...provider('failed-fallback-probe', '无可用模板'),
    apiBaseUrl: 'https://failed-fallback.example/v1',
    baseUrl: 'https://failed-fallback.example/v1',
  };
  const service = new HubService({ getAll: () => [item], getRecentRequests: () => [] }, {
    async query() { return { message: 'shape mismatch' }; },
  });

  const result = await service.probeTemplates(item.id);

  assert.equal(result.balance.recommendedTemplateId, '');
  assert.equal(result.balance.fallbackTemplateId, '');
  assert.equal(result.balance.results.at(-1).templateId, 'api-health-local');
  assert.equal(result.balance.results.at(-1).status, 'failed');
});

test('Hub probes an unchanged built-in selection with the same execution path that save preserves', async () => {
  const item = {
    ...provider('muyuan-probe', '君的公益'),
    apiBaseUrl: 'https://muyuan.do/v1',
    baseUrl: 'https://muyuan.do/v1',
  };
  const balanceCalls = [];
  const requestCalls = [];
  const service = new HubService({ getAll: () => [item] }, {
    async query(_provider, options) {
      balanceCalls.push(options);
      return {
        source: 'muyuan_account',
        usage: { providerName: item.name, remaining: 9, used: 1, total: 10, unit: 'USD' },
      };
    },
  }, {
    requestUsageEngine: {
      async query(_provider, options) {
        requestCalls.push(options);
        return { success: true, source: 'provider_log', requestCount: 1, billing: { exact: true, unit: 'USD' } };
      },
    },
  });

  const result = await service.probeTemplates(item.id, {
    balanceTemplateId: 'new-api-key-quota',
    requestUsageTemplateId: 'new-api-token-log',
  });

  assert.equal(result.balance.recommendedTemplateId, 'new-api-key-quota');
  assert.equal(result.requestUsage.recommendedTemplateId, 'new-api-token-log');
  assert.equal(Object.hasOwn(balanceCalls[0], 'balanceTemplateId'), false);
  assert.equal(Object.hasOwn(requestCalls[0], 'requestUsageTemplateId'), false);
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

test('Hub keeps browser-only refreshes inside the configured browser concurrency', async () => {
  const providers = [
    provider('browser-one', 'agentrouter'),
    provider('browser-two', 'any的国内镜像'),
    provider('browser-three', 'agentrouter backup'),
  ];
  let runningBrowser = 0;
  let maximumBrowser = 0;
  const service = new HubService({ getAll: () => providers }, {
    async query(item) {
      assert.match(item.name, /agentrouter|any/);
      runningBrowser += 1;
      maximumBrowser = Math.max(maximumBrowser, runningBrowser);
      await new Promise(resolve => setTimeout(resolve, 8));
      runningBrowser -= 1;
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

  assert.equal(maximumBrowser, 1);
});

test('Hub serializes API-key providers that may fall back to browser account queries', async () => {
  const providers = [
    { ...provider('muyuan-one', '君的公益'), apiBaseUrl: 'https://muyuan.do/v1', baseUrl: 'https://muyuan.do/v1' },
    { ...provider('muyuan-two', '君的公益-zrf'), apiBaseUrl: 'https://muyuan.do/v1', baseUrl: 'https://muyuan.do/v1' },
    { ...provider('welfare-one', '无名公益站'), apiBaseUrl: 'https://welfare.0xpsyche.me/v1', baseUrl: 'https://welfare.0xpsyche.me/v1' },
    provider('direct-one', 'DeepSeek'),
  ];
  let runningConditional = 0;
  let maximumConditional = 0;
  const service = new HubService({ getAll: () => providers }, {
    async query(item) {
      const conditional = /君的公益|无名公益站/.test(item.name);
      if (conditional) {
        runningConditional += 1;
        maximumConditional = Math.max(maximumConditional, runningConditional);
      }
      await new Promise(resolve => setTimeout(resolve, 8));
      if (conditional) runningConditional -= 1;
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-25T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  }, { concurrency: 3, browserConcurrency: 1 });

  const conditionalMethods = service.getState().providers
    .filter(item => /君的公益|无名公益站/.test(item.name))
    .map(item => item.queryMethod.type);
  assert.deepEqual(conditionalMethods, [
    'api-key-with-account-fallback',
    'api-key-with-account-fallback',
    'api-key-with-account-fallback',
  ]);

  await service.refreshAll();

  assert.equal(maximumConditional, 1);
});

test('Hub full refresh tolerates a queued provider being removed during the operation', async () => {
  const first = provider('one', 'DeepSeek', true);
  const second = provider('two', 'PackyCode');
  let providers = [first, second];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const service = new HubService({ getAll: () => providers }, {
    async query(item) {
      if (item.id === first.id) {
        markFirstStarted();
        await firstGate;
      }
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-22T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  }, { concurrency: 1 });

  const refresh = service.refreshAll();
  await firstStarted;
  providers = [first];
  service.syncProviders();
  releaseFirst();

  const state = await refresh;
  assert.deepEqual(state.providers.map(item => item.id), [first.id]);
  assert.equal(state.providers[0].status, 'ok');
  assert.ok(state.lastFullRefreshAt);
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

test('Hub reuses derived public provider metadata until the repository snapshot changes', () => {
  let providers = [provider('one', 'DeepSeek', true), provider('two', 'PackyCode')];
  const service = new HubService({ getAll: () => providers }, { query: async () => ({}) });

  const first = service.listPublicProviders();
  const unchanged = service.listPublicProviders();

  assert.equal(unchanged, first, 'unchanged provider metadata should not be rebuilt for every read');
  assert.deepEqual(first.map(item => item.name), ['DeepSeek', 'PackyCode']);

  providers = [provider('one', 'DeepSeek renamed', true)];
  service.syncProviders();
  const changed = service.listPublicProviders();

  assert.notEqual(changed, first, 'a new repository snapshot must invalidate the metadata cache');
  assert.deepEqual(changed.map(item => item.name), ['DeepSeek renamed']);
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

test('changing a template aborts the obsolete refresh before starting its replacement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-hub-refresh-template-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const item = {
    ...provider('one', '模板竞态中转', true),
    apiBaseUrl: 'https://race.example/v1',
    baseUrl: 'https://race.example/v1',
    apiKey: 'race-private-key',
  };
  const calls = [];
  let running = 0;
  let maximum = 0;
  const service = new HubService({ getAll: () => [item] }, {
    query(_provider, options) {
      running += 1;
      maximum = Math.max(maximum, running);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          running -= 1;
          callback(value);
        };
        const call = {
          options,
          resolve: value => finish(resolve, value),
        };
        calls.push(call);
        options.signal?.addEventListener('abort', () => {
          finish(reject, options.signal.reason || new Error('aborted'));
        }, { once: true });
      });
    },
  }, {
    templateStore: new ProviderTemplateStore(path.join(directory, 'bindings.json')),
  });

  const obsoleteRefresh = service.refreshProvider(item.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);

  service.saveTemplateSelection(item.id, { balanceTemplateId: 'new-api-key-quota' });
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(service.getState().refreshing, true, 'the obsolete refresh stays tracked until cleanup');
  const replacementRefresh = service.refreshProvider(item.id);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(maximum, 1, 'obsolete and replacement queries must not overlap');
  assert.equal(calls[1].options.balanceTemplateId, 'new-api-key-quota');
  calls[1].resolve({
    source: 'new_api_key',
    usage: {
      status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
      unit: 'USD', extra: '', updatedAt: '2026-07-26T00:00:00.000Z', refreshIntervalMinutes: 5,
    },
  });

  await obsoleteRefresh;
  const refreshed = await replacementRefresh;
  assert.equal(refreshed.usage.remaining, 9);
  assert.equal(refreshed.templateSelection.balanceSource, 'manual');
});

test('changing a provider account invalidates its previous successful balance', async () => {
  let providers = [{ ...provider('one', 'DeepSeek old'), apiKey: 'old-account-key' }];
  const service = new HubService({ getAll: () => providers }, {
    query: async item => ({
      source: 'test',
      usage: {
        status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
        unit: 'USD', extra: '', updatedAt: '2026-07-17T00:00:00.000Z', refreshIntervalMinutes: 5,
      },
    }),
  });
  await service.refreshProvider('one');

  providers = [{ ...providers[0], name: 'DeepSeek new', apiKey: 'new-account-key' }];
  service.syncProviders();
  const item = service.getState().providers[0];

  assert.equal(item.name, 'DeepSeek new');
  assert.equal(item.status, 'idle');
  assert.equal(item.usage, null);
  assert.match(item.message, /配置已变更/);
  assert.equal('providerFingerprint' in item, false, 'configuration hashes stay out of public Hub state');
});

test('Hub errors redact bearer tokens and preserve the last successful usage', async () => {
  const item = provider('one', 'AgentRouter');
  let fail = false;
  let now = Date.parse('2026-07-18T12:00:00.000Z');
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
  }, { now: () => now });

  await service.refreshProvider(item.id);
  fail = true;
  now = Date.parse('2026-07-19T12:34:56.000Z');
  await service.refreshProvider(item.id);
  const state = service.getState().providers[0];

  assert.equal(state.status, 'degraded');
  assert.equal(state.usage.remaining, 8);
  assert.equal(state.updatedAt, '2026-07-14T00:00:00.000Z');
  assert.equal(state.lastSuccessAt, '2026-07-14T00:00:00.000Z');
  assert.equal(state.lastAttemptAt, '2026-07-19T12:34:56.000Z');
  assert.doesNotMatch(state.message, /secret-value/);
  assert.match(state.message, /\[redacted\]/);
});

test('Hub redacts exact provider credentials from unlabeled state, usage, and persisted cache text', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-hub-secret-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'hub-cache.json');
  const apiKey = 'offline-arbitrary-key-value-123456789';
  const accessToken = 'offline-access-value-987654321';
  const item = {
    ...provider('secret-provider', 'Offline secret provider'),
    apiKey,
    auth: { tokens: { access_token: accessToken } },
  };
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      return {
        source: 'offline-test',
        degraded: true,
        message: `upstream echoed ${apiKey} and ${accessToken}`,
        usage: {
          status: 'ok', providerName: item.name, used: 1, remaining: 2, total: 3,
          unit: 'USD', extra: `opaque ${apiKey}`, refreshIntervalMinutes: 5,
        },
      };
    },
  }, { cachePath });

  await service.refreshProvider(item.id);
  const serializedState = JSON.stringify(service.getState());
  const serializedCache = fs.readFileSync(cachePath, 'utf8');
  for (const secret of [apiKey, accessToken]) {
    assert.doesNotMatch(serializedState, new RegExp(secret));
    assert.doesNotMatch(serializedCache, new RegExp(secret));
  }
  assert.match(serializedState, /\[redacted\]/);
  assert.match(serializedCache, /\[redacted\]/);
});

test('Hub strips provider credentials from public metadata and footer payloads', () => {
  const apiKey = 'metadata-private-key-123456789';
  const accessToken = 'metadata-access-token-987654321';
  const item = {
    ...provider('metadata-secret', `Mirror ${apiKey}`),
    apiKey,
    auth: { tokens: { access_token: accessToken } },
    websiteUrl: `https://example.com/${apiKey}?token=${accessToken}`,
  };
  const service = new HubService({ getAll: () => [item] }, { async query() { return {}; } });
  const footer = hubItemToUsagePayload(item, {
    status: 'error',
    message: `upstream echoed ${apiKey} ${accessToken}`,
  });
  const serialized = JSON.stringify({
    state: service.getState(),
    providers: service.listPublicProviders(),
    footer,
  });
  assert.doesNotMatch(serialized, new RegExp(apiKey));
  assert.doesNotMatch(serialized, new RegExp(accessToken));
  assert.equal(footer.websiteUrl, '');
});

test('Hub ignores an oversized cache before parsing provider state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-hub-large-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'hub-cache.json');
  fs.writeFileSync(cachePath, '{');
  fs.truncateSync(cachePath, 8_000_001);
  const item = provider('oversized-cache', 'Offline');
  const service = new HubService({ getAll: () => [item] }, { async query() { return {}; } }, { cachePath });
  const state = service.getState().providers[0];
  assert.equal(state.status, 'idle');
  assert.equal(state.usage, null);
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

  const usageWithoutExtra = sanitizeHubUsage({
    status: 'ok', providerName: 'freely 账户总额度', extra: '',
    used: 0, remaining: 2600, total: 2600, unit: 'USD',
  });
  assert.equal(usageWithoutExtra.extra, '');
});

test('Hub restores cached browser failures as degraded usage instead of stale login state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-hub-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'hub-cache.json');
  const cachedProvider = provider('one', 'any的国内镜像');
  const providerFingerprint = new HubService(
    { getAll: () => [cachedProvider] },
    { query: async () => ({}) },
  ).getProviderConfigurationFingerprint(cachedProvider);
  fs.writeFileSync(cachePath, JSON.stringify({
    providers: [{
      id: 'one',
      providerFingerprint,
      status: 'degraded',
      source: 'browser_session',
      message: '显示上次成功余额；浏览器伴侣连接后将自动重试（现有浏览器尚未登录该网站）',
      usage: {
        providerName: 'AnyRouter', used: 2, remaining: 8, total: 10, unit: 'USD', extra: '',
        periodLabel: '', hideTotal: false, refreshIntervalMinutes: 5, updatedAt: '2026-07-15T00:00:00.000Z',
      },
    }],
  }), 'utf8');

  const service = new HubService({ getAll: () => [cachedProvider] }, { query: async () => ({}) }, { cachePath });
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
    apiKey: 'same-anyrouter-key',
    apiBaseUrl: 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1',
  };
  const foreign = {
    ...provider('foreign', 'any的国外我自己的'),
    apiKey: 'same-anyrouter-key',
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
  assert.equal(service.findProvider(domestic.id).apiBaseUrl, 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1');
});

test('AnyRouter results stay isolated when provider API keys differ', async () => {
  const edge = { ...provider('edge', 'any的国内镜像'), apiKey: 'edge-key' };
  const chrome = { ...provider('chrome', 'any的国外我自己的'), apiKey: 'chrome-key' };
  const queryOptions = [];
  const service = new HubService({ getAll: () => [edge, chrome] }, {
    async query(item, options) {
      queryOptions.push(options);
      const remaining = item.id === edge.id ? 80 : 40;
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 10, remaining, total: remaining + 10,
          unit: 'USD', extra: '', updatedAt: `2026-07-25T00:00:0${item.id === edge.id ? 1 : 2}.000Z`, refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.refreshProvider(edge.id);
  await service.refreshProvider(chrome.id);
  const state = service.getState().providers;

  assert.equal(state.find(item => item.id === edge.id).usage.remaining, 80);
  assert.equal(state.find(item => item.id === chrome.id).usage.remaining, 40);
  assert.equal(queryOptions.every(options => options.allowSoleSessionFallback === false), true);
});

test('Hub persists an AnyRouter browser binding without exposing its account fingerprint', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-anyrouter-binding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'hub-cache.json');
  const domestic = { ...provider('domestic-bound', 'any的国内镜像'), apiKey: 'shared-bound-key' };
  const foreign = { ...provider('foreign-bound', 'any的国外我自己的'), apiKey: 'shared-bound-key' };
  const queryOptions = [];
  const binding = {
    clientRef: 'edge-ref-one', browser: 'Edge', origin: 'https://anyrouter.top',
    accountRef: 'A'.repeat(43), boundAt: '2026-07-25T00:00:00.000Z',
  };
  const queryEngine = {
    async bindBrowserAccount(item, options) {
      assert.equal(item.id, foreign.id);
      assert.deepEqual(options, { clientRef: 'edge-ref-one' });
      return { binding };
    },
    async query(item, options) {
      queryOptions.push({ id: item.id, binding: options.accountBinding });
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, accountBrowser: 'Edge',
          used: 20, remaining: 80, total: 100, unit: 'USD', extra: '已使用绑定的 Edge AnyRouter 账号',
          updatedAt: '2026-07-25T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  };
  const repository = { getAll: () => [domestic, foreign] };
  const service = new HubService(repository, queryEngine, { cachePath });

  await service.bindAccount(foreign.id, { clientRef: 'edge-ref-one' });

  const state = service.getState().providers;
  for (const item of state) {
    assert.deepEqual(item.accountBinding, { clientRef: 'edge-ref-one', browser: 'Edge' });
    assert.equal(JSON.stringify(item).includes('A'.repeat(43)), false);
    assert.equal(item.status, 'ok');
  }
  assert.equal(queryOptions.length, 1);
  assert.deepEqual(queryOptions[0].binding, binding);

  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(persisted.providers.every(item => item.accountBinding.accountRef === 'A'.repeat(43)), true);
  const restored = new HubService(repository, { async query() { return {}; } }, { cachePath });
  assert.deepEqual(restored.getState().providers[0].accountBinding, { clientRef: 'edge-ref-one', browser: 'Edge' });
});

test('AnyRouter binding discards a browser result when provider configuration changes in flight', async () => {
  const original = { ...provider('any-race', 'any的国外我自己的'), apiKey: 'old-key' };
  let providers = [original];
  let releaseBinding;
  let markStarted;
  let queryCalls = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseBinding = resolve; });
  const service = new HubService({ getAll: () => providers }, {
    async bindBrowserAccount() {
      markStarted();
      await gate;
      return {
        binding: {
          clientRef: 'edge-ref-one', browser: 'Edge', origin: 'https://anyrouter.top',
          accountRef: 'R'.repeat(43), boundAt: '2026-07-29T00:00:00.000Z',
        },
      };
    },
    async query() { queryCalls += 1; return {}; },
  });

  const pending = service.bindAccount(original.id, { clientRef: 'edge-ref-one' });
  await started;
  providers = [{ ...original, apiKey: 'new-key' }];
  releaseBinding();

  await assert.rejects(pending, /绑定期间已变更/);
  assert.equal(queryCalls, 0, 'the stale binding must never reach the replacement provider query');
  assert.equal(service.getState().providers[0].accountBinding, null);
});

test('AnyRouter binding invalidates an older balance refresh and reruns with the new account', async () => {
  const item = { ...provider('any-refresh-race', 'any的国外我自己的'), apiKey: 'race-key' };
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const queryBindings = [];
  const binding = {
    clientRef: 'edge-ref-one', browser: 'Edge', origin: 'https://anyrouter.top',
    accountRef: 'B'.repeat(43), boundAt: '2026-07-29T00:00:00.000Z',
  };
  const service = new HubService({ getAll: () => [item] }, {
    async bindBrowserAccount() { return { binding }; },
    async query(current, options) {
      queryBindings.push(options.accountBinding || null);
      if (queryBindings.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      const bound = Boolean(options.accountBinding);
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: current.id, providerName: current.name,
          used: bound ? 20 : 90, remaining: bound ? 80 : 10, total: 100,
          unit: 'USD', extra: '', updatedAt: '2026-07-29T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  const staleRefresh = service.refreshProvider(item.id);
  await firstStarted;
  const bindingRefresh = service.bindAccount(item.id, { clientRef: 'edge-ref-one' });
  while (!service.getState().providers[0].accountBinding) {
    await new Promise(resolve => setImmediate(resolve));
  }
  releaseFirst();
  await Promise.all([staleRefresh, bindingRefresh]);

  assert.equal(queryBindings.length, 2);
  assert.equal(queryBindings[0], null);
  assert.deepEqual(queryBindings[1], binding);
  const state = service.getState().providers[0];
  assert.equal(state.usage.remaining, 80);
  assert.deepEqual(state.accountBinding, { clientRef: 'edge-ref-one', browser: 'Edge' });
});

test('AnyRouter binding fails closed and rolls back when Hub cache persistence fails', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-binding-cache-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const blocker = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'blocked', 'utf8');
  const item = { ...provider('any-cache-failure', 'any的国外我自己的'), apiKey: 'binding-key' };
  let queryCalls = 0;
  const service = new HubService({ getAll: () => [item] }, {
    async bindBrowserAccount() {
      return {
        binding: {
          clientRef: 'chrome-ref-one', browser: 'Chrome', origin: 'https://anyrouter.top',
          accountRef: 'C'.repeat(43), boundAt: '2026-07-29T00:00:00.000Z',
        },
      };
    },
    async query() { queryCalls += 1; return {}; },
  }, { cachePath: path.join(blocker, 'hub-cache.json') });

  await assert.rejects(service.bindAccount(item.id, { clientRef: 'chrome-ref-one' }), /未能保存/);
  const state = service.getState();
  assert.equal(state.providers[0].accountBinding, null);
  assert.ok(state.cacheError, 'the persistence failure must remain visible in Hub diagnostics');
  assert.equal(queryCalls, 0);
});

test('Hub clears a bound AnyRouter balance when the browser account changes', async () => {
  const item = { ...provider('any-switched', 'any的国外我自己的'), apiKey: 'bound-key' };
  let switched = false;
  const binding = {
    clientRef: 'chrome-ref-one', browser: 'Chrome', origin: 'https://anyrouter.top',
    accountRef: 'B'.repeat(43), boundAt: '2026-07-25T00:00:00.000Z',
  };
  const service = new HubService({ getAll: () => [item] }, {
    async bindBrowserAccount() { return { binding }; },
    async query() {
      if (switched) {
        return {
          source: 'browser_session', loginRequired: true, accountBindingMismatch: true, invalidateUsage: true,
          message: '绑定的 Chrome AnyRouter 账号已变化；请重新绑定',
        };
      }
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, accountBrowser: 'Chrome',
          used: 20, remaining: 80, total: 100, unit: 'USD', extra: '',
          updatedAt: '2026-07-25T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.bindAccount(item.id, { clientRef: 'chrome-ref-one' });
  assert.equal(service.getState().providers[0].usage.remaining, 80);
  switched = true;
  await service.refreshProvider(item.id);

  const state = service.getState().providers[0];
  assert.equal(state.status, 'login-required');
  assert.equal(state.usage, null);
  assert.match(state.message, /账号已变化/);
  assert.deepEqual(state.accountBinding, { clientRef: 'chrome-ref-one', browser: 'Chrome' });
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
  let receivedOptions = null;
  const service = new HubService({ getAll: () => [item] }, {
    async openLogin(_provider, options) {
      receivedOptions = options;
      return { synced: false, opened: true, origin: 'https://anyrouter.top', browser: 'Chrome' };
    },
    async query() { return { source: 'browser_session', loginRequired: true, websiteLoginRequired: true, message: '需要官网认证' }; },
  });

  await service.refreshProvider(item.id);
  assert.equal(service.getState().providers[0].websiteLoginRequired, true);
  const opened = await service.openLogin(item.id, { clientRef: 'chrome-ref-one' });
  assert.deepEqual(receivedOptions, { clientRef: 'chrome-ref-one' });
  assert.equal(opened.websiteLoginRequired, true);
  assert.match(opened.message, /Chrome 浏览器.*登录页/);
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

test('public v1 balance reads return cache without starting another provider query', async () => {
  const item = provider('one', 'AgentRouter');
  let queries = 0;
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      queries += 1;
      return {
        source: 'browser_session',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-15T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });
  await service.refreshProvider(item.id);

  const one = service.getBalance('agentrouter');
  const all = service.getAllBalances();

  assert.equal(queries, 1);
  assert.equal(one.cache_only, true);
  assert.equal(one.data.remaining, 9);
  assert.equal(one.last_success_at, '2026-07-15T00:00:00.000Z');
  assert.equal(all.cache_only, true);
  assert.equal(all.data.one.data.remaining, 9);
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
      accountBrowser: 'Chrome',
      periodLabel: '', hideTotal: false, refreshIntervalMinutes: 5, updatedAt: '2026-07-15T00:00:00.000Z',
    },
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.providerDisplayName, 'AgentRouter');
  assert.equal(payload.accountBrowser, 'Chrome');
  assert.equal(payload.remaining, 8);
  assert.equal(payload.queryError, '需要网页登录');
});
