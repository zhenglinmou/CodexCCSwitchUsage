import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyProviderRequestLogApp,
  describeProviderRequestUsage,
  isProviderRequestLogRow,
  normalizeRequestUsageLimit,
  parseProviderRequestLog,
  parseProviderRequestLogs,
  ProviderRequestUsageEngine,
} from '../src/provider-request-usage.mjs';

function statusPayload(overrides = {}) {
  return {
    success: true,
    data: {
      quota_display_type: 'USD',
      quota_per_unit: 500_000,
      usd_exchange_rate: 7.3,
      ...overrides,
    },
  };
}

function logPayload(rows) {
  return { success: true, message: '', data: rows };
}

test('request-usage descriptions are domain-pinned and do not expose credentials', () => {
  const supported = describeProviderRequestUsage({
    id: 'freely-id',
    name: 'freely的',
    apiBaseUrl: 'https://free.lyclaude.site/v1',
    apiKey: 'freely-private-key',
  });
  assert.equal(supported.supported, true);
  assert.equal(supported.adapter, 'new-api-token-log');
  assert.equal(supported.requestUrl, 'https://free.lyclaude.site/api/log/token');
  assert.equal(supported.configurationUrl, 'https://free.lyclaude.site/api/status');
  assert.doesNotMatch(JSON.stringify(supported), /freely-private-key/);

  const untrusted = describeProviderRequestUsage({
    id: 'renamed',
    name: 'freely的',
    apiBaseUrl: 'https://unrelated.example/v1',
    apiKey: 'private-key',
  });
  assert.equal(untrusted.supported, false);
  assert.equal(untrusted.requestUrl, '');

  const anyRouter = describeProviderRequestUsage({
    id: 'any',
    name: 'any的国外我自己的',
    apiBaseUrl: 'https://anyrouter.top/v1',
    apiKey: 'private-key',
  });
  assert.equal(anyRouter.supported, true);
  assert.equal(anyRouter.adapter, 'new-api-token-log');
  assert.equal(anyRouter.requestUrl, 'https://anyrouter.top/api/log/token');
  assert.match(anyRouter.executor, /浏览器伴侣/);

  const domesticAnyRouter = describeProviderRequestUsage({
    id: 'any-cn',
    name: 'any的国内镜像',
    apiBaseUrl: 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1',
    apiKey: 'private-key',
  });
  assert.equal(domesticAnyRouter.supported, true);
  assert.equal(domesticAnyRouter.requestUrl, 'https://anyrouter.top/api/log/token');

  const muyuan = describeProviderRequestUsage({
    id: 'muyuan',
    name: '君的公益',
    apiBaseUrl: 'https://muyuan.do/v1',
    apiKey: 'private-key',
  });
  assert.equal(muyuan.supported, true);
  assert.equal(muyuan.requestUrl, 'https://muyuan.do/api/log/token');
  assert.match(muyuan.executor, /浏览器伴侣/);
});

test('an explicit New API log template stays on an unknown provider configured origin', async () => {
  const provider = {
    id: 'new-relay',
    name: '新中转',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'relay-private-key',
  };
  const automatic = describeProviderRequestUsage(provider);
  assert.equal(automatic.supported, false);
  assert.equal(automatic.templateId, 'ccswitch-local');

  const selected = describeProviderRequestUsage(provider, 'new-api-token-log');
  assert.equal(selected.supported, true);
  assert.equal(selected.requestUrl, 'https://relay.example/api/log/token');
  assert.doesNotMatch(JSON.stringify(selected), /relay-private-key/);

  const calls = [];
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.Authorization });
      const payload = String(url).endsWith('/api/status')
        ? statusPayload()
        : logPayload([]);
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const result = await engine.query(provider, { requestUsageTemplateId: 'new-api-token-log' });
  assert.equal(result.success, true);
  assert.equal(result.requestCount, 0);
  assert.deepEqual(calls, [
    { url: 'https://relay.example/api/log/token', authorization: 'Bearer relay-private-key' },
    { url: 'https://relay.example/api/status', authorization: undefined },
  ]);
});

test('request usage probes reuse their shared raw-response cache', async () => {
  const provider = {
    id: 'shared-probe',
    name: '共享探测中转',
    apiBaseUrl: 'https://shared-probe.example/v1',
    apiKey: 'shared-private-key',
  };
  const calls = [];
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => {
      calls.push(String(url));
      const payload = String(url).endsWith('/api/status') ? statusPayload() : logPayload([]);
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const requestCache = { responses: new Map() };
  const options = {
    requestUsageTemplateId: 'new-api-token-log',
    bypassCache: true,
    requestCache,
  };

  const results = await Promise.all([
    engine.query(provider, options),
    engine.query(provider, options),
  ]);

  assert.ok(results.every(result => result.success));
  assert.deepEqual(calls.sort(), [
    'https://shared-probe.example/api/log/token',
    'https://shared-probe.example/api/status',
  ]);
  assert.doesNotMatch(JSON.stringify([...requestCache.responses.keys()]), /shared-private-key/);
});

test('request log normalization keeps provider charge, token details, timing, and failure status', () => {
  const item = parseProviderRequestLog({
    id: 42,
    request_id: 'request-42',
    upstream_request_id: 'upstream-42',
    created_at: 1_700_000_000,
    type: 5,
    model_name: 'gpt-5.6-sol',
    quota: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    use_time: 3.4,
    is_stream: true,
    other: JSON.stringify({
      status_code: 503,
      cache_tokens: 12,
      cache_write_tokens: 7,
      frt: 125,
      billing_source: 'wallet',
      request_path: '/v1/responses',
    }),
  }, { displayType: 'USD', quotaPerUnit: 500_000, multiplier: 1, unit: 'USD', exact: true });

  assert.deepEqual(item, {
    id: '42',
    requestId: 'request-42',
    upstreamRequestId: 'upstream-42',
    createdAt: '2023-11-14T22:13:20.000Z',
    model: 'gpt-5.6-sol',
    recordType: 'error',
    recordTypeCode: 5,
    success: false,
    statusCode: 503,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 12,
    cacheCreationTokens: 7,
    totalTokens: 0,
    usageReturned: false,
    rawQuota: 0,
    totalCost: 0,
    costUnit: 'USD',
    costExact: true,
    costSource: 'provider_log',
    durationSeconds: 3.4,
    latencyMs: 3_400,
    firstTokenMs: 125,
    isStream: true,
    billingSource: 'wallet',
    requestPath: '/v1/responses',
  });
});

test('request log parser sorts newest records and applies the bounded limit', () => {
  const rows = parseProviderRequestLogs(logPayload([
    { id: 1, created_at: 10, type: 2, model_name: 'old', quota: 1, prompt_tokens: 1, completion_tokens: 1 },
    { id: 3, created_at: 30, type: 2, model_name: 'newer', quota: 3, prompt_tokens: 3, completion_tokens: 1 },
    { id: 2, created_at: 30, type: 2, model_name: 'same-time', quota: 2, prompt_tokens: 2, completion_tokens: 1 },
  ]), { displayType: 'USD', quotaPerUnit: 1, multiplier: 1, unit: 'USD', exact: true }, 2);
  assert.deepEqual(rows.map(row => row.model), ['newer', 'same-time']);
  assert.deepEqual(rows.map(row => row.totalCost), [3, 2]);
  assert.equal(normalizeRequestUsageLimit(0), 10);
  assert.equal(normalizeRequestUsageLimit(999), 50);
  assert.equal(isProviderRequestLogRow({ id: 1, created_at: 10, type: 2, quota: 1 }), true);
  assert.equal(isProviderRequestLogRow({ id: 1, created_at: 10, type: 99, quota: 1 }), false);
  assert.equal(isProviderRequestLogRow({ unexpected: true }), false);
  assert.throws(
    () => parseProviderRequestLogs(logPayload([{ unexpected: true }]), null, 10),
    /New API 日志行/,
  );
});

test('request-usage rejects empty logs when status has no New API schema evidence', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? { success: true, data: {} }
      : logPayload([])), { status: 200 }),
  });
  const result = await engine.query({
    id: 'lookalike', name: '伪 New API 站', apiBaseUrl: 'https://lookalike.example/v1', apiKey: 'private-key',
  }, { requestUsageTemplateId: 'new-api-token-log' });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'schema');
  assert.match(result.message, /无法验证 New API/);
});

test('request-usage rejects nonempty arrays without recognizable New API log rows', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([{ unexpected: true }])), { status: 200 }),
  });
  const result = await engine.query({
    id: 'lookalike', name: '伪 New API 站', apiBaseUrl: 'https://lookalike.example/v1', apiKey: 'private-key',
  }, { requestUsageTemplateId: 'new-api-token-log' });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'schema');
  assert.match(result.message, /New API 日志行/);
});

test('remote request logs separate Codex from Claude before selecting the latest ten', () => {
  const rows = [
    { id: 4, created_at: 40, type: 2, model_name: 'claude-sonnet-4', quota: 4, other: JSON.stringify({ request_path: '/v1/messages' }) },
    { id: 3, created_at: 30, type: 2, model_name: 'gpt-5.6-sol', quota: 3, other: JSON.stringify({ request_path: '/v1/responses' }) },
    { id: 2, created_at: 20, type: 2, model_name: 'claude-opus-4', quota: 2 },
    { id: 1, created_at: 10, type: 2, model_name: 'gpt-5.6-sol', quota: 1 },
    { id: 0, created_at: 5, type: 2, model_name: 'unknown-model', quota: 1 },
  ];
  const display = { displayType: 'USD', quotaPerUnit: 1, multiplier: 1, unit: 'USD', exact: true };

  assert.equal(classifyProviderRequestLogApp(rows[0]), 'claude');
  assert.equal(classifyProviderRequestLogApp(rows[1]), 'codex');
  assert.deepEqual(
    parseProviderRequestLogs(logPayload(rows), display, 10, { appType: 'codex', strictAppType: true }).map(item => item.id),
    ['3', '1'],
  );
});

test('request-usage engine queries New API logs and status without sending the key to status', async () => {
  const calls = [];
  const engine = new ProviderRequestUsageEngine({
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/status')) {
        return new Response(JSON.stringify(statusPayload({ quota_display_type: 'CNY', usd_exchange_rate: 7.2 })), { status: 200 });
      }
      return new Response(JSON.stringify(logPayload([
        {
          id: 2,
          created_at: 100,
          type: 5,
          model_name: 'gpt-5.6-sol',
          quota: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          other: JSON.stringify({ status_code: 502 }),
        },
        {
          id: 1,
          created_at: 99,
          type: 2,
          model_name: 'gpt-5.6-sol',
          quota: 25_000,
          prompt_tokens: 1_000,
          completion_tokens: 25,
          other: JSON.stringify({ cache_tokens: 900 }),
        },
      ])), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'freely-id',
    name: 'freely的',
    apiBaseUrl: 'https://free.lyclaude.site/v1',
    apiKey: 'freely-private-key',
  }, { limit: 2 });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_log');
  assert.equal(result.billing.unit, 'CNY');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].statusCode, 502);
  assert.equal(result.items[0].totalCost, 0);
  assert.equal(result.items[1].inputTokens, 1_000);
  assert.equal(result.items[1].cacheReadTokens, 900);
  assert.equal(result.items[1].totalCost, 0.36);
  assert.equal(result.items[1].costExact, true);
  assert.deepEqual(calls, [
    { url: 'https://free.lyclaude.site/api/log/token', authorization: 'Bearer freely-private-key' },
    { url: 'https://free.lyclaude.site/api/status', authorization: undefined },
  ]);
});

test('AnyRouter request usage falls through WAF HTML to the connected browser companion', async () => {
  const browserCalls = [];
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async () => new Response('<html>challenge</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    browserBroker: {
      isConnected: () => true,
      async queryJson(request) {
        browserCalls.push(request);
        const payload = request.requestPath === '/api/status'
          ? statusPayload()
          : logPayload([{ id: 1, created_at: 10, type: 2, quota: 5_000, prompt_tokens: 10, completion_tokens: 2 }]);
        return { status: 200, text: JSON.stringify(payload) };
      },
    },
  });

  const result = await engine.query({
    id: 'any-cn',
    name: 'any的国内镜像',
    apiBaseUrl: 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1',
    apiKey: 'any-private-key',
  });

  assert.equal(result.success, true);
  assert.equal(result.items[0].totalCost, 0.01);
  assert.deepEqual(browserCalls.map(call => ({
    baseUrl: call.baseUrl,
    requestPath: call.requestPath,
    authorization: call.headers.Authorization,
  })).sort((left, right) => left.requestPath.localeCompare(right.requestPath)), [
    { baseUrl: 'https://anyrouter.top', requestPath: '/api/log/token', authorization: 'Bearer any-private-key' },
    { baseUrl: 'https://anyrouter.top', requestPath: '/api/status', authorization: undefined },
  ]);
});

test('君的公益 request usage falls through a WAF 403 to the connected browser companion', async () => {
  const browserCalls = [];
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async () => new Response('<html>cloudflare challenge</html>', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    }),
    browserBroker: {
      isConnected: () => true,
      async queryJson(request) {
        browserCalls.push(request);
        const payload = request.requestPath === '/api/status'
          ? statusPayload({ quota_display_type: 'CNY', usd_exchange_rate: 7.2 })
          : logPayload([{ id: 1, created_at: 10, type: 2, quota: 5_000, prompt_tokens: 10, completion_tokens: 2 }]);
        return { status: 200, text: JSON.stringify(payload) };
      },
    },
  });

  const result = await engine.query({
    id: 'muyuan',
    name: '君的公益',
    apiBaseUrl: 'https://muyuan.do/v1',
    apiKey: 'muyuan-private-key',
  });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_log');
  assert.equal(result.billing.unit, 'CNY');
  assert.equal(result.items[0].totalCost, 0.072);
  assert.deepEqual(browserCalls.map(call => ({
    baseUrl: call.baseUrl,
    requestPath: call.requestPath,
    authorization: call.headers.Authorization,
  })).sort((left, right) => left.requestPath.localeCompare(right.requestPath)), [
    { baseUrl: 'https://muyuan.do', requestPath: '/api/log/token', authorization: 'Bearer muyuan-private-key' },
    { baseUrl: 'https://muyuan.do', requestPath: '/api/status', authorization: undefined },
  ]);
});

test('legacy New API status without quota_display_type falls back to USD', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? { success: true, data: { display_in_currency: true, quota_per_unit: 500_000 } }
      : logPayload([{ id: 1, created_at: 1, type: 2, quota: 500_000, prompt_tokens: 10, completion_tokens: 2 }])), { status: 200 }),
  });
  const result = await engine.query({
    id: 'agent', name: 'agentrouter', apiBaseUrl: 'https://agentrouter.org', apiKey: 'agent-key',
  });
  assert.equal(result.success, true);
  assert.equal(result.billing.unit, 'USD');
  assert.equal(result.items[0].totalCost, 1);
});

test('request-usage engine returns structured unsupported results without probing official or website-session-only sites', async () => {
  let calls = 0;
  const engine = new ProviderRequestUsageEngine({ fetchImpl: async () => { calls += 1; throw new Error('must not call'); } });

  const deepSeek = await engine.query({
    id: 'deepseek', name: 'DeepSeek', apiBaseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key',
  });
  assert.equal(deepSeek.success, false);
  assert.equal(deepSeek.supported, false);
  assert.match(deepSeek.message, /没有按 API Key/);

  const excluded = await engine.query({
    id: 'paid', name: '付费站', apiBaseUrl: 'https://rawchat.cn/v1', apiKey: 'paid-key',
  });
  assert.equal(excluded.supported, false);
  assert.equal(excluded.source, 'website-session-only');
  assert.match(excluded.message, /CCSwitch/);
  assert.equal(calls, 0);
});

test('Packy remote log failures are returned instead of falling back to CCSwitch local cost', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : { success: false, message: 'record not found' }), { status: 200 }),
  });
  const result = await engine.query({
    id: 'packy', name: 'PackyCode', apiBaseUrl: 'https://www.packyapi.com/v1', apiKey: 'packy-key',
  });
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 200);
  assert.match(result.message, /record not found/);
  assert.deepEqual(result.items, []);
});
