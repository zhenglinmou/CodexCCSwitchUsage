import assert from 'node:assert/strict';
import test from 'node:test';
import { loginConfiguration, parseBrowserJson, ProviderQueryEngine, providerAliases, providerKind, summarizeWham } from '../src/hub-provider-adapters.mjs';

test('browser callback JSON parsing rejects WAF HTML and oversized responses', () => {
  assert.deepEqual(parseBrowserJson('{"success":true}'), { success: true });
  assert.deepEqual(parseBrowserJson('response\n{"data":{"quota":1}}\n'), { data: { quota: 1 } });
  assert.equal(parseBrowserJson('<html>WAF challenge</html>'), null);
  assert.equal(parseBrowserJson('x'.repeat(2_000_001)), null);
});

test('Hub provider routing recognizes the current CCSwitch Codex provider families', () => {
  assert.equal(providerKind({ name: 'any的国外我自己的' }), 'anyrouter');
  assert.equal(providerKind({ name: 'agentrouter' }), 'agentrouter');
  assert.equal(providerKind({ name: 'OpenAI Official-我自己的' }), 'openai');
  assert.equal(providerKind({ name: '官方对接的 CPA' }), 'cpa');
  assert.equal(providerKind({ name: '付费站 copy' }), 'paid');
  assert.equal(providerKind({ name: '未识别供应商' }), 'generic');
  assert.equal(loginConfiguration({ name: 'DeepSeek' }), null);
  assert.equal(loginConfiguration({ name: 'agentrouter' }).loginUrl, 'https://agentrouter.org/login');
});

test('provider aliases preserve the stable local gateway paths', () => {
  assert.ok(providerAliases({ id: 'one', name: 'any的国内镜像' }).includes('anyrouter_cn'));
  assert.ok(providerAliases({ id: 'two', name: 'OpenAI Official-我自己的' }).includes('openai_personal'));
  assert.ok(providerAliases({ id: 'three', name: '付费站 copy' }).includes('paid_sharedchat'));
});

test('OpenAI wham payload is normalized into primary and secondary quota windows', () => {
  const summary = summarizeWham({
    plan_type: 'plus',
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_after_seconds: 900 },
      secondary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_after_seconds: 2_000 },
    },
    credits: { balance: 7.5 },
  });

  assert.equal(summary.plan, 'plus');
  assert.equal(summary.used, 35);
  assert.equal(summary.remaining, 65);
  assert.equal(summary.limits[0].label, '5小时');
  assert.equal(summary.limits[1].label, '7天');
  assert.equal(summary.creditBalance, 7.5);
});

test('browser-only providers probe the model API before requesting a website login', async () => {
  const calls = [];
  const engine = new ProviderQueryEngine({}, { hasSession: () => false, isConnected: () => false }, {
    fetchImpl: async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'agent', name: 'agentrouter', websiteUrl: '', usage: { code: 'old bridge code' }, auth: {},
    apiKey: 'model-key', apiBaseUrl: 'https://api.agent.example', baseUrl: 'http://127.0.0.1:17891',
  });

  assert.equal(result.loginRequired, true);
  assert.equal(result.source, 'api_key_probe');
  assert.match(result.message, /API Key 可用/);
  assert.deepEqual(calls, ['https://api.agent.example/models']);
  assert.doesNotMatch(calls.join(' '), /17891/);
});

test('WAF balance queries use the connected existing-browser callback and never auto-open login', async () => {
  let loginCalls = 0;
  let queryCalls = 0;
  const broker = {
    hasSession: () => true,
    isConnected: () => true,
    async queryJson() {
      queryCalls += 1;
      return { status: 200, text: '{"success":true,"data":{"quota":5000000,"used_quota":500000,"group":"vip"}}' };
    },
    async openLogin() { loginCalls += 1; },
  };
  const engine = new ProviderQueryEngine({}, broker, { fetchImpl: async () => { throw new Error('model API must not run after a browser session is known'); } });
  const provider = { id: 'agent', name: 'agentrouter', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://agentrouter.org' };

  const result = await engine.query(provider);

  assert.equal(result.source, 'browser_session');
  assert.equal(result.usage.remaining, 10);
  assert.equal(queryCalls, 1);
  assert.equal(loginCalls, 0);
});

test('OpenAI token queries fall back to the paired existing-browser callback without exposing the token', async () => {
  const edgeCalls = [];
  const engine = new ProviderQueryEngine({}, {
    hasLoginState: () => false,
    async queryJson(request) {
      edgeCalls.push(request);
      return {
        status: 200,
        text: JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
        }),
      };
    },
  }, {
    homeDir: 'Z:\\missing-home',
    fetchImpl: async () => { throw new Error('node transport unavailable'); },
  });

  const result = await engine.query({
    id: 'openai', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(result.source, 'openai_wham_browser');
  assert.equal(result.usage.remaining, 75);
  assert.equal(edgeCalls.length, 1);
  assert.equal(edgeCalls[0].headers.Authorization, 'Bearer private-token');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('duplicate provider copies reuse one recent balance request to avoid rate limiting', async () => {
  let requests = 0;
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.5' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const base = { name: 'DeepSeek', websiteUrl: 'https://platform.deepseek.com', usage: null, auth: {}, apiKey: 'same-key', apiBaseUrl: 'https://api.deepseek.com', baseUrl: 'https://api.deepseek.com' };

  const first = await engine.query({ ...base, id: 'first' });
  const second = await engine.query({ ...base, id: 'copy' });

  assert.equal(requests, 1);
  assert.equal(first.usage.providerId, 'first');
  assert.equal(second.usage.providerId, 'copy');
  assert.equal(second.usage.remaining, 12.5);
});

test('paid-site copies sharing one API key reuse the result across mirror domains', async () => {
  let requests = 0;
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async url => {
      requests += 1;
      assert.doesNotMatch(String(url), /17891/);
      return new Response('{"status":"ok","balance_3h":4,"used_3h":1,"limit_3h":5,"balance_1d":9,"used_1d":1,"limit_1d":10}', { status: 200 });
    },
  });
  const base = { websiteUrl: '', usage: { enabled: true, code: 'old usage_script must not run' }, auth: {}, apiKey: 'shared-key' };

  const first = await engine.query({ ...base, id: 'raw', name: '付费站', apiBaseUrl: 'https://raw.example', baseUrl: 'https://old-bridge.invalid' });
  const second = await engine.query({ ...base, id: 'copy', name: '付费站 copy', apiBaseUrl: 'https://mirror.example', baseUrl: 'https://old-bridge.invalid' });

  assert.equal(requests, 1);
  assert.equal(first.usage.remaining, 9);
  assert.equal(second.usage.providerId, 'copy');
});
