import assert from 'node:assert/strict';
import test from 'node:test';
import { loginConfiguration, ProviderQueryEngine, providerKind, solveAnyRouterChallenge, summarizeWham } from '../src/hub-provider-adapters.mjs';

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

test('AnyRouter challenge solver is deterministic and returns a 20-byte cookie value', () => {
  const solved = solveAnyRouterChallenge('0123456789abcdef0123456789abcdef01234567');
  assert.match(solved, /^[0-9a-f]{40}$/);
  assert.equal(solved, solveAnyRouterChallenge('0123456789abcdef0123456789abcdef01234567'));
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

test('legacy bridge login failures remain actionable instead of becoming generic errors', async () => {
  const engine = new ProviderQueryEngine({}, { hasPersistentState: () => false }, {
    fetchImpl: async url => {
      assert.match(String(url), /\/v1\/balance\/openai_official$/);
      return new Response(JSON.stringify({
        success: true,
        data: { isValid: false, loginRequired: true, invalidMessage: '登录已过期' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await engine.query({
    id: 'openai', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    usage: null, auth: {}, apiKey: '', baseUrl: '',
  });

  assert.equal(result.loginRequired, true);
  assert.equal(result.source, 'legacy_bridge');
  assert.equal(result.message, '登录已过期');
});

test('OpenAI token queries fall back to the dedicated Edge transport without exposing the token', async () => {
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
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', baseUrl: '',
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
  const base = { name: 'DeepSeek', websiteUrl: 'https://platform.deepseek.com', usage: null, auth: {}, apiKey: 'same-key', baseUrl: 'https://api.deepseek.com' };

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
    fetchImpl: async () => {
      requests += 1;
      return new Response('{"remaining":9,"used":1,"total":10}', { status: 200 });
    },
  });
  const code = `({
    request: { url: "{{baseUrl}}/user/balance", headers: { Authorization: "Bearer {{apiKey}}" } },
    extractor: response => ({ planName: "付费站", remaining: response.remaining, used: response.used, total: response.total })
  })`;
  const base = { websiteUrl: '', usage: { enabled: true, code, timeout: 10 }, auth: {}, apiKey: 'shared-key' };

  await engine.query({ ...base, id: 'raw', name: '付费站', baseUrl: 'https://raw.example' });
  await engine.query({ ...base, id: 'copy', name: '付费站 copy', baseUrl: 'https://mirror.example' });

  assert.equal(requests, 1);
});
