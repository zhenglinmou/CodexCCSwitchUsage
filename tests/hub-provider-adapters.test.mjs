import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  describeProviderQuery,
  fetchJson,
  isWhamUsagePayload,
  loginConfiguration,
  parseBrowserJson,
  parseDeepSeekBalancePayload,
  parseFreelyAccountPayload,
  parseFreelyDisplayPayload,
  parseFreelyTokenPayload,
  parseJianzhileAccountPayload,
  parseJianzhileDisplayPayload,
  parseJianzhileTokenPayload,
  parseNewApiBalancePayload,
  parsePackyBalancePayload,
  parseWindowBalancePayload,
  ProviderQueryEngine,
  providerAliases,
  providerKind,
  summarizeWham,
} from '../src/hub-provider-adapters.mjs';
import { resetHttpAllowlistCache } from '../src/http-allowlist.mjs';

const jianzhileStatusPayload = (overrides = {}) => ({
  success: true,
  data: {
    quota_display_type: 'USD',
    quota_per_unit: 500_000,
    usd_exchange_rate: 1,
    custom_currency_exchange_rate: 1,
    custom_currency_symbol: '¤',
    ...overrides,
  },
});

test('CPA local account discovery ignores oversized auth files', async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-cpa-auth-bounds-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const authDirectory = path.join(homeDir, '.cli-proxy-api');
  fs.mkdirSync(authDirectory);
  const oversized = path.join(authDirectory, 'oversized.json');
  fs.writeFileSync(oversized, JSON.stringify({ type: 'codex', account_id: 'account-one', access_token: 'secret' }));
  fs.truncateSync(oversized, 1_000_001);
  let fetchCalls = 0;
  const engine = new ProviderQueryEngine({}, null, {
    homeDir,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not query oversized credentials'); },
  });

  const result = await engine.query({
    id: 'cpa', name: 'CPA', apiBaseUrl: 'http://127.0.0.1:8317/v1', baseUrl: 'http://127.0.0.1:8317/v1',
    websiteUrl: '', apiKey: '', auth: {}, usage: null,
  }, { balanceTemplateId: 'cpa-local' });
  assert.equal(result.source, 'cpa_auth_files');
  assert.equal(result.loginRequired, true);
  assert.equal(fetchCalls, 0);
});

function twoBrowserNewApiBroker(options = {}) {
  const calls = [];
  const metrics = { active: 0, maximum: 0 };
  const matchingClientRef = options.matchingClientRef || 'chrome-account';
  const matchingKey = options.matchingKey || 'abcd**********wxyz';
  const edgeAccount = options.edgeAccount || { id: 99, quota: 90_000_000, used_quota: 10_000_000, request_count: 99 };
  const chromeAccount = options.chromeAccount || { id: 42, quota: 45_000_000, used_quota: 5_000_000, request_count: 9 };
  return {
    calls,
    broker: {
      isConnected: () => true,
      listQueryClients: () => [
        { clientId: 'edge-account', clientRef: 'edge-account', browser: 'Edge', hasSession: true },
        { clientId: 'chrome-account', clientRef: 'chrome-account', browser: 'Chrome', hasSession: true },
      ],
      async queryJson(request) {
        calls.push({ clientRef: 'generic', request });
        return { status: 200, text: JSON.stringify({ success: true, data: edgeAccount }) };
      },
      async queryJsonOnClient(clientRef, request) {
        calls.push({ clientRef, request });
        metrics.active += 1;
        metrics.maximum = Math.max(metrics.maximum, metrics.active);
        try {
          if (options.requestDelayMs) {
            await new Promise(resolve => setTimeout(resolve, options.requestDelayMs));
          }
          if (request.requestPath.startsWith('/api/token/')) {
            return {
              status: 200,
              text: JSON.stringify({
                success: true,
                data: {
                  items: [{ key: clientRef === matchingClientRef ? matchingKey : 'edge**********acct' }],
                  total: 1,
                },
              }),
            };
          }
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              data: clientRef === 'chrome-account' ? chromeAccount : edgeAccount,
            }),
          };
        } finally {
          metrics.active -= 1;
        }
      },
    },
    metrics,
  };
}

test('browser callback JSON parsing rejects WAF HTML and oversized responses', () => {
  assert.deepEqual(parseBrowserJson('{"success":true}'), { success: true });
  assert.deepEqual(parseBrowserJson('response\n{"data":{"quota":1}}\n'), { data: { quota: 1 } });
  assert.equal(parseBrowserJson('<html>WAF challenge</html>'), null);
  assert.equal(parseBrowserJson('x'.repeat(2_000_001)), null);
});

test('provider HTTP parsing stops an oversized stream instead of buffering the full response', async () => {
  const chunks = [new Uint8Array(1_100_000), new Uint8Array(1_100_000), new Uint8Array(1_100_000)];
  let reads = 0;
  let cancelled = false;
  const response = {
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks[reads];
            reads += 1;
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
  };

  await assert.rejects(fetchJson(async () => response, 'https://offline.invalid', {}, 1_000, 1), /响应过大/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('template probes share one parsed response per URL without retaining credential text in cache keys', async () => {
  let requests = 0;
  const requestCache = { responses: new Map() };
  const fetchImpl = async () => {
    requests += 1;
    return new Response('{"success":true}', { status: 200 });
  };

  const [first, second] = await Promise.all([
    fetchJson(fetchImpl, 'https://relay.example/api/status', {
      Authorization: 'Bearer private-probe-key',
      Accept: 'application/json',
      'User-Agent': 'first-probe',
    }, 1_000, 1, null, 0, requestCache),
    fetchJson(fetchImpl, 'https://relay.example/api/status', {
      Authorization: 'Bearer private-probe-key',
      Accept: 'application/json',
      'User-Agent': 'second-probe',
    }, 1_000, 1, null, 0, requestCache),
  ]);

  assert.equal(requests, 1);
  assert.deepEqual(first.payload, { success: true });
  assert.deepEqual(second.payload, { success: true });
  assert.doesNotMatch(JSON.stringify([...requestCache.responses.keys()]), /private-probe-key|relay\.example/);
});

test('an external abort cancels a provider query and its active HTTP request', async () => {
  let requestAborted = false;
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      const abort = () => {
        requestAborted = true;
        reject(options.signal.reason || new Error('aborted'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = engine.query({
    id: 'abort-query', name: 'DeepSeek', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://api.deepseek.com', baseUrl: '',
  }, {
    balanceTemplateId: 'deepseek-balance',
    bypassCache: true,
    signal: controller.signal,
  });

  controller.abort(new Error('template changed'));

  await assert.rejects(pending, /template changed/);
  assert.equal(requestAborted, true);
});

test('aborting one shared query consumer keeps the request alive for another provider', async () => {
  let requests = 0;
  let releaseResponse;
  let requestSignal;
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async (_url, options) => {
      requests += 1;
      requestSignal = options.signal;
      return new Promise(resolve => {
        releaseResponse = () => resolve(new Response(JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '5' }],
        }), { status: 200 }));
      });
    },
  });
  const common = {
    name: 'DeepSeek', websiteUrl: '', usage: null, auth: {},
    apiKey: 'same-private-key', apiBaseUrl: 'https://api.deepseek.com', baseUrl: '',
  };
  const controller = new AbortController();
  const first = engine.query({ ...common, id: 'first' }, {
    balanceTemplateId: 'deepseek-balance',
    signal: controller.signal,
  });
  const second = engine.query({ ...common, id: 'second' }, {
    balanceTemplateId: 'deepseek-balance',
  });

  controller.abort(new Error('first consumer left'));
  await assert.rejects(first, /first consumer left/);
  assert.equal(requests, 1);
  assert.equal(requestSignal.aborted, false);
  releaseResponse();

  const result = await second;
  assert.equal(result.usage.providerId, 'second');
  assert.equal(result.usage.remaining, 5);
});

test('Hub provider routing recognizes the current CCSwitch Codex provider families', () => {
  assert.equal(providerKind({ name: 'any的国外我自己的', apiBaseUrl: 'https://anyrouter.top/v1' }), 'anyrouter');
  assert.equal(providerKind({ name: 'agentrouter', apiBaseUrl: 'https://agentrouter.org' }), 'agentrouter');
  assert.equal(providerKind({ name: 'OpenAI Official-我自己的', websiteUrl: 'https://chatgpt.com/codex' }), 'openai');
  assert.equal(providerKind({ name: '简直了', apiBaseUrl: 'https://jianzhile.vip' }), 'jianzhile');
  assert.equal(providerKind({ name: 'freely的', apiBaseUrl: 'https://free.lyclaude.site/v1' }), 'freely');
  assert.equal(providerKind({ name: '君的公益', apiBaseUrl: 'https://muyuan.do/v1' }), 'muyuan');
  assert.equal(providerKind({ name: '随便改名', apiBaseUrl: 'https://welfare.0xpsyche.me/v1' }), 'welfare');
  assert.equal(providerKind({ name: '随便改名', apiBaseUrl: 'https://www.mofas.one/v1' }), 'mofa');
  assert.equal(providerKind({ name: '官方对接的 CPA', apiBaseUrl: 'http://localhost:8317/v1' }), 'cpa');
  assert.equal(providerKind({ name: '付费站 copy' }), 'paid');
  assert.equal(providerKind({ name: '未识别供应商' }), 'generic');
  assert.equal(loginConfiguration({ name: 'DeepSeek' }), null);
  assert.equal(loginConfiguration({ name: 'agentrouter', apiBaseUrl: 'https://agentrouter.org' }).loginUrl, 'https://agentrouter.org/login');
  assert.equal(loginConfiguration({ name: 'freely的', apiBaseUrl: 'https://free.lyclaude.site/v1' }).loginUrl, 'https://free.lyclaude.site/login');
  assert.equal(loginConfiguration({ name: '君的公益', apiBaseUrl: 'https://muyuan.do/v1' }).requestPath, '/api/user/self');
  assert.equal(loginConfiguration({ name: '无名公益站', apiBaseUrl: 'https://welfare.0xpsyche.me' }).loginUrl, 'https://welfare.0xpsyche.me/login');
  assert.equal(describeProviderQuery({ name: '魔方公益站', apiBaseUrl: 'https://www.mofas.one/v1' }).templateId, 'new-api-key-quota');
});

test('fixed-target adapters require domain evidence and survive harmless renaming', () => {
  assert.equal(providerKind({ name: '我的主力', apiBaseUrl: 'https://www.packyapi.com/v1' }), 'packy');
  assert.equal(providerKind({ name: 'Packy 临时备份', apiBaseUrl: 'https://unrelated.example/v1' }), 'generic');
  assert.equal(providerKind({ name: 'Packy 临时备份', apiBaseUrl: 'https://unrelated.example/v1', websiteUrl: 'https://www.packyapi.com' }), 'generic');
  assert.equal(providerKind({ name: '随便改名', apiBaseUrl: 'https://api.deepseek.com' }), 'deepseek');
  assert.equal(providerKind({ name: 'agentrouter', apiBaseUrl: 'https://unrelated.example' }), 'generic');
  assert.equal(providerKind({ name: '简直了', apiBaseUrl: 'https://unrelated.example/v1' }), 'generic');
  assert.equal(providerKind({ name: '其他名称', apiBaseUrl: 'https://api.jianzhile.vip/v1' }), 'generic');
  assert.equal(providerKind({ name: 'freely的', apiBaseUrl: 'https://unrelated.example/v1' }), 'generic');
  assert.equal(providerKind({ name: '其他名称', apiBaseUrl: 'https://api.free.lyclaude.site/v1' }), 'generic');
  assert.equal(providerKind({ name: '君的公益', apiBaseUrl: 'https://unrelated.example/v1' }), 'generic');
  assert.equal(providerKind({ name: '君的公益', apiBaseUrl: 'https://api.muyuan.do/v1' }), 'generic');
  assert.equal(providerKind({ name: '无名公益站', apiBaseUrl: 'https://unrelated.example/v1' }), 'generic');
  assert.equal(providerKind({ name: '无名公益站', apiBaseUrl: 'https://api.welfare.0xpsyche.me/v1' }), 'generic');
  assert.equal(providerKind({ name: '魔方公益站', apiBaseUrl: 'https://unrelated.example/v1' }), 'generic');
});

test('balance schemas preserve real zeroes and reject missing or malformed values', () => {
  assert.deepEqual(parseNewApiBalancePayload({
    success: true,
    data: { quota: 0, used_quota: '0', request_count: 0 },
  }), { group: '', remaining: 0, used: 0, total: 0, requestCount: 0 });
  assert.throws(() => parseNewApiBalancePayload({ success: true, data: { used_quota: 0 } }), /quota/);
  assert.throws(() => parseNewApiBalancePayload({ success: true, data: { quota: 'NaN', used_quota: 0 } }), /quota/);

  assert.deepEqual(parseDeepSeekBalancePayload({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '0' }],
  }), [{ currency: 'USD', value: 0 }]);
  assert.throws(() => parseDeepSeekBalancePayload({ is_available: true }), /balance_infos/);

  assert.deepEqual(parsePackyBalancePayload({
    code: true,
    data: { total_available: 0, total_used: '0', quota_reset_period: '' },
  }), {
    remaining: 0,
    used: 0,
    total: 0,
    unlimited: null,
    quotaMode: 'effective-key',
    resetPeriod: '未知',
  });
  assert.deepEqual(parsePackyBalancePayload({
    code: true,
    data: {
      unlimited_quota: true,
      total_available: 15_000_000,
      total_used: 85_355_019,
      quota_reset_period: 'daily',
    },
  }), {
    remaining: 30,
    used: 170.710038,
    total: 200.710038,
    unlimited: true,
    quotaMode: 'unlimited-effective',
    resetPeriod: 'daily',
  });
  assert.throws(() => parsePackyBalancePayload({ code: true, data: { total_available: 0 } }), /total_used/);
  assert.throws(() => parsePackyBalancePayload({
    code: true,
    data: { total_available: 0, total_used: 0, total_granted: 0, unlimited_quota: true },
  }), /quota_reset_period/);
  assert.throws(() => parsePackyBalancePayload({
    code: true,
    data: { total_available: 0, total_used: 0, quota_reset_period: 86_400 },
  }), /quota_reset_period/);
  assert.throws(() => parsePackyBalancePayload({
    code: true,
    data: { total_available: 0, total_used: 0, quota_reset_period: 'daily', unlimited_quota: 'true' },
  }), /unlimited_quota/);

  assert.deepEqual(parseWindowBalancePayload({
    status: 'ok',
    balance_3h: 4,
    used_3h: 1,
    limit_3h: 5,
    balance_1d: 9,
    used_1d: 1,
    limit_1d: 10,
    unit: 'USD',
  }), {
    shortWindow: { remaining: 4, used: 1, total: 5 },
    daily: { remaining: 9, used: 1, total: 10 },
    unit: 'USD',
  });
  assert.deepEqual(parseWindowBalancePayload({
    is_active: true,
    quota: {
      '3h': { remaining: 2, used: 1, total: 3 },
      daily: { remaining: 6, used: 4, total: 10 },
    },
  }).daily, { remaining: 6, used: 4, total: 10 });
  assert.throws(() => parseWindowBalancePayload({
    status: 'ok',
    quota: {
      '3h': { remaining: 90, used: 80, total: 100 },
      daily: { remaining: 400, used: 20, total: 300 },
    },
  }), /total.*used.*remaining|总额/);
  assert.throws(() => parseWindowBalancePayload({
    status: 'ok', balance_1d: 9, used_1d: 1, limit_1d: 10,
  }), /3h/);
  assert.throws(() => parseWindowBalancePayload({
    balance_3h: 4, used_3h: 1, limit_3h: 5, balance_1d: 9, used_1d: 1, limit_1d: 10,
  }), /状态/);

  assert.deepEqual(parseJianzhileTokenPayload({
    code: true,
    data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: '1000000', total_granted: 5_000_000 },
  }), { name: 'finite', unlimited: false, remaining: 8, used: 2, total: 10 });
  assert.throws(() => parseJianzhileTokenPayload({
    code: true,
    data: { name: 'inconsistent', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 6_000_000 },
  }), /total_granted/);
  assert.deepEqual(parseJianzhileTokenPayload({
    code: true,
    data: { name: 'unlimited', unlimited_quota: true, total_available: -5, total_used: 10, total_granted: 5 },
  }), { name: 'unlimited', unlimited: true, remaining: null, used: 0.00002, total: null });
  assert.throws(() => parseJianzhileTokenPayload({ code: true, data: { unlimited_quota: false, total_available: 0 } }), /total_used/);

  const cny = parseJianzhileDisplayPayload(jianzhileStatusPayload({ quota_display_type: 'CNY', usd_exchange_rate: 7.2 }));
  assert.deepEqual(cny, { quotaPerUnit: 500_000, multiplier: 7.2, unit: 'CNY' });
  assert.deepEqual(parseJianzhileDisplayPayload({
    success: true,
    data: { display_in_currency: true, quota_per_unit: 500_000 },
  }), { quotaPerUnit: 500_000, multiplier: 1, unit: 'USD' });
  assert.deepEqual(parseJianzhileDisplayPayload({
    success: true,
    data: { display_in_currency: false, quota_per_unit: 500_000 },
  }), { quotaPerUnit: 1, multiplier: 1, unit: 'quota' });
  assert.deepEqual(parseJianzhileTokenPayload({
    code: true,
    data: { name: 'finite-cny', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
  }, cny), { name: 'finite-cny', unlimited: false, remaining: 57.6, used: 14.4, total: 72 });
  assert.deepEqual(parseJianzhileAccountPayload({
    success: true,
    data: { quota: 4_000_000, used_quota: 1_000_000 },
  }, cny), { remaining: 57.6, used: 14.4, total: 72 });

  const freelyUsd = parseFreelyDisplayPayload(jianzhileStatusPayload({ quota_display_type: 'USD', usd_exchange_rate: 7.3 }));
  assert.deepEqual(freelyUsd, { quotaPerUnit: 500_000, multiplier: 1, unit: 'USD' });
  assert.deepEqual(parseFreelyTokenPayload({
    code: true,
    data: { name: 'freely-finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
  }, freelyUsd), { name: 'freely-finite', unlimited: false, remaining: 8, used: 2, total: 10 });
  assert.deepEqual(parseFreelyAccountPayload({
    success: true,
    data: { quota: 4_000_000, used_quota: 1_000_000 },
  }, freelyUsd), { remaining: 8, used: 2, total: 10 });
});

test('auto-detect balance schemas reject every other template response shape', () => {
  const fixtures = {
    newApiAccount: { success: true, data: { quota: 4_000_000, used_quota: 1_000_000, request_count: 5 } },
    newApiToken: {
      code: true,
      data: { name: 'key', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
    },
    deepSeek: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5' }] },
    packy: { code: true, data: { total_available: 4_000_000, total_used: 1_000_000, quota_reset_period: 'daily' } },
    window: { status: 'ok', balance_3h: 4, used_3h: 1, limit_3h: 5, balance_1d: 9, used_1d: 1, limit_1d: 10 },
  };
  const parsers = {
    newApiAccount: parseNewApiBalancePayload,
    newApiToken: parseJianzhileTokenPayload,
    deepSeek: parseDeepSeekBalancePayload,
    packy: parsePackyBalancePayload,
    window: parseWindowBalancePayload,
  };

  for (const [fixtureName, fixture] of Object.entries(fixtures)) {
    const accepted = Object.entries(parsers).flatMap(([parserName, parser]) => {
      try {
        parser(fixture);
        return [parserName];
      } catch {
        return [];
      }
    });
    assert.deepEqual(accepted, [fixtureName], `${fixtureName} must match exactly one balance template`);
  }
});

test('provider aliases preserve the stable local gateway paths', () => {
  assert.ok(providerAliases({ id: 'one', name: 'any的国内镜像', apiBaseUrl: 'https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1' }).includes('anyrouter_cn'));
  assert.ok(providerAliases({ id: 'two', name: 'OpenAI Official-我自己的', websiteUrl: 'https://chatgpt.com/codex' }).includes('openai_personal'));
  assert.ok(providerAliases({ id: 'three', name: '付费站 copy' }).includes('paid_sharedchat'));
  assert.ok(providerAliases({ id: 'four', name: '任意名称', apiBaseUrl: 'https://jianzhile.vip/v1' }).includes('jianzhile'));
  assert.ok(providerAliases({ id: 'five', name: '任意名称', apiBaseUrl: 'https://free.lyclaude.site/v1' }).includes('freely'));
  assert.ok(providerAliases({ id: 'six', name: '任意名称', apiBaseUrl: 'https://muyuan.do/v1' }).includes('muyuan'));
  assert.ok(providerAliases({ id: 'seven', name: '任意名称', apiBaseUrl: 'https://welfare.0xpsyche.me/v1' }).includes('welfare'));
});

test('provider query descriptions expose the real request shape without credentials', () => {
  const browserMethod = describeProviderQuery({
    name: 'agentrouter',
    apiBaseUrl: 'https://user:password@agentrouter.org/v1/?access_token=private',
    apiKey: 'sk-private-key',
  });
  assert.equal(browserMethod.requestUrl, 'https://agentrouter.org/api/user/self');
  assert.equal(browserMethod.method, 'GET');
  assert.equal(browserMethod.requiresBrowser, true);
  assert.equal(browserMethod.waf, true);
  assert.match(browserMethod.authentication, /Cookie/);
  assert.match(browserMethod.authentication, /扩展本地保存的数字用户 ID.*New-Api-User/);
  assert.doesNotMatch(browserMethod.authentication, /localStorage/);
  assert.doesNotMatch(JSON.stringify(browserMethod), /\/models/);
  assert.doesNotMatch(JSON.stringify(browserMethod), /password|access_token|private-key/);

  const apiMethod = describeProviderQuery({
    name: '付费站',
    apiBaseUrl: 'https://balance.example/v1',
    apiKey: 'another-private-key',
  });
  assert.equal(apiMethod.requestUrl, 'https://balance.example/v1/user/balance');
  assert.match(apiMethod.authentication, /Bearer API Key.*无需官网登录/);
  assert.equal(apiMethod.requiresBrowser, false);
  assert.doesNotMatch(JSON.stringify(apiMethod), /another-private-key/);

  const jianzhileMethod = describeProviderQuery({
    name: '简直了',
    apiBaseUrl: 'https://jianzhile.vip/v1',
    apiKey: 'jianzhile-private-key',
  });
  assert.equal(jianzhileMethod.requestUrl, 'https://jianzhile.vip/api/usage/token/');
  assert.match(jianzhileMethod.authentication, /无限 Key/);
  assert.doesNotMatch(JSON.stringify(jianzhileMethod), /jianzhile-private-key/);

  const freelyMethod = describeProviderQuery({
    name: 'freely的',
    apiBaseUrl: 'https://free.lyclaude.site/v1',
    apiKey: 'freely-private-key',
  });
  assert.equal(freelyMethod.requestUrl, 'https://free.lyclaude.site/api/usage/token/');
  assert.match(freelyMethod.authentication, /无限 Key/);
  assert.doesNotMatch(JSON.stringify(freelyMethod), /freely-private-key/);

  const muyuanMethod = describeProviderQuery({
    name: '君的公益',
    apiBaseUrl: 'https://muyuan.do/v1',
    apiKey: 'muyuan-private-key',
  });
  assert.equal(muyuanMethod.requestUrl, 'https://muyuan.do/api/usage/token/');
  assert.equal(muyuanMethod.waf, true);
  assert.match(muyuanMethod.authentication, /无限 Key/);
  assert.match(muyuanMethod.executor, /浏览器伴侣/);
  assert.doesNotMatch(JSON.stringify(muyuanMethod), /muyuan-private-key/);

  const welfareMethod = describeProviderQuery({
    name: '无名公益站',
    apiBaseUrl: 'https://welfare.0xpsyche.me/v1',
    apiKey: 'welfare-private-key',
  });
  assert.equal(welfareMethod.requestUrl, 'https://welfare.0xpsyche.me/api/usage/token/');
  assert.match(welfareMethod.authentication, /无限 Key/);
  assert.doesNotMatch(JSON.stringify(welfareMethod), /welfare-private-key/);
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
  assert.equal(isWhamUsagePayload({ rate_limit: { primary_window: { used_percent: 25 } } }), false);
  assert.equal(isWhamUsagePayload({ rate_limit: { primary_window: { used_percent: -1, limit_window_seconds: 18_000 } } }), false);
  assert.equal(isWhamUsagePayload({ rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 18_000 } } }), false);
  const mixed = summarizeWham({
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: -1, limit_window_seconds: 604_800 },
    },
  });
  assert.equal(mixed.limits.length, 1);
});

test('browser-only providers never probe the model API when the companion is disconnected', async () => {
  const calls = [];
  const engine = new ProviderQueryEngine({}, { hasSession: () => false, isConnected: () => false }, {
    fetchImpl: async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'agent', name: 'agentrouter', websiteUrl: '', usage: { code: 'old bridge code' }, auth: {},
    apiKey: 'model-key', apiBaseUrl: 'https://agentrouter.org', baseUrl: 'http://127.0.0.1:17891',
  });

  assert.equal(result.loginRequired, false);
  assert.equal(result.source, 'browser_session');
  assert.match(result.message, /伴侣扩展未连接/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(calls.join(' '), /17891/);
});

test('provider API keys are never sent to remote HTTP endpoints', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-http-provider-'));
  const allowlist = path.join(directory, 'allow-http-origins.json');
  fs.writeFileSync(allowlist, JSON.stringify({ providers: { 'local-http': ['http://127.0.0.1:18080'] } }));
  const previousAllowlist = process.env.CCSWITCH_HTTP_ALLOWLIST_FILE;
  process.env.CCSWITCH_HTTP_ALLOWLIST_FILE = allowlist;
  resetHttpAllowlistCache();
  t.after(() => {
    if (previousAllowlist === undefined) delete process.env.CCSWITCH_HTTP_ALLOWLIST_FILE;
    else process.env.CCSWITCH_HTTP_ALLOWLIST_FILE = previousAllowlist;
    resetHttpAllowlistCache();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const calls = [];
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '1' }],
      }), { status: 200 });
    },
  });

  await assert.rejects(engine.query({
    id: 'remote-http', name: 'DeepSeek', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'http://remote.example', baseUrl: '',
  }), /非本地供应商接口必须使用 HTTPS/);
  assert.deepEqual(calls, []);

  const local = await engine.query({
    id: 'local-http', name: 'DeepSeek', websiteUrl: '', usage: null, auth: {},
    apiKey: 'local-key', apiBaseUrl: 'http://127.0.0.1:18080', baseUrl: '',
  });
  assert.equal(local.usage.remaining, 1);
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:18080/user/balance',
    authorization: 'Bearer local-key',
  }]);
});

test('direct Packy API key balances are marked as not requiring website login', async () => {
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async () => new Response(JSON.stringify({
      code: true,
      data: { unlimited_quota: true, total_available: 4_000_000, total_used: 1_000_000, quota_reset_period: 'daily' },
    }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'packy-direct', name: 'PackyCode', websiteUrl: 'https://www.packyapi.com', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://www.packyapi.com/v1', baseUrl: '',
  });

  assert.equal(result.source, 'provider_api');
  assert.equal(result.loginRequired, false);
  assert.equal(result.usage.remaining, 8);
  assert.equal(result.usage.used, 2);
  assert.equal(result.usage.total, 10);
  assert.match(result.usage.extra, /无限 API Key.*有效额度/);
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
});

test('jianzhile finite API keys use only their own configured quota', async () => {
  const calls = [];
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { browserCalls += 1; throw new Error('finite keys must not query the browser'); },
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/status')) {
        return new Response(JSON.stringify(jianzhileStatusPayload()), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: true,
        data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
      }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'jianzhile-finite', name: '简直了', websiteUrl: 'https://jianzhile.vip', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://jianzhile.vip', baseUrl: '',
  });

  assert.equal(result.source, 'jianzhile_api_key');
  assert.equal(result.usage.remaining, 8);
  assert.equal(result.usage.used, 2);
  assert.equal(result.usage.total, 10);
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
  assert.equal(browserCalls, 0);
  assert.deepEqual(calls, [
    { url: 'https://jianzhile.vip/api/usage/token/', authorization: 'Bearer private-key' },
    { url: 'https://jianzhile.vip/api/status', authorization: undefined },
  ]);
});

test('jianzhile unlimited API keys switch to the logged-in account total quota', async () => {
  const { broker, calls: browserCalls } = twoBrowserNewApiBroker();
  const engine = new ProviderQueryEngine({}, broker, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: { name: 'unlimited', unlimited_quota: true, total_available: -4_000_001, total_used: 4_000_000, total_granted: -1 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'jianzhile-unlimited', name: '简直了', websiteUrl: 'https://jianzhile.vip', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://jianzhile.vip/v1', baseUrl: '',
  });

  assert.equal(result.source, 'jianzhile_account');
  assert.equal(result.usage.remaining, 90);
  assert.equal(result.usage.used, 10);
  assert.equal(result.usage.total, 100);
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.match(result.usage.extra, /已通过 Chrome 核验/);
  assert.deepEqual(browserCalls.map(call => `${call.clientRef}:${call.request.requestPath}`).sort(), [
    'chrome-account:/api/token/?p=1&size=100',
    'chrome-account:/api/user/self',
    'edge-account:/api/token/?p=1&size=100',
    'edge-account:/api/user/self',
  ]);
});

test('jianzhile unlimited API keys request website session sync instead of using placeholders', async () => {
  const engine = new ProviderQueryEngine({}, { isConnected: () => false }, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: { unlimited_quota: true, total_available: -5, total_used: 4, total_granted: -1 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'jianzhile-offline', name: '简直了', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://jianzhile.vip', baseUrl: '',
  });

  assert.equal(result.usage, undefined);
  assert.equal(result.loginRequired, true);
  assert.equal(result.sessionSyncRequired, true);
  assert.doesNotMatch(result.message, /100000000/);
});

test('welfare New API providers use the configured key quota instead of the HTML models route', async () => {
  const calls = [];
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { browserCalls += 1; throw new Error('finite keys must not query the browser'); },
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/status')) {
        return new Response(JSON.stringify(jianzhileStatusPayload()), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: true,
        data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
      }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'welfare-finite', name: '无名公益站', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://welfare.0xpsyche.me', baseUrl: '',
  });

  assert.equal(result.source, 'welfare_api_key');
  assert.equal(result.usage.remaining, 8);
  assert.equal(result.usage.used, 2);
  assert.equal(result.usage.total, 10);
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
  assert.equal(browserCalls, 0);
  assert.deepEqual(calls, [
    { url: 'https://welfare.0xpsyche.me/api/usage/token/', authorization: 'Bearer private-key' },
    { url: 'https://welfare.0xpsyche.me/api/status', authorization: undefined },
  ]);
});

test('welfare unlimited keys use only the logged-in account that owns the provider key', async () => {
  const browserCalls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientId: 'edge-account', browser: 'Edge', hasSession: true },
      { clientId: 'chrome-zrf', browser: 'Chrome', hasSession: true },
    ],
    async queryJsonOnClient(clientId, request) {
      browserCalls.push({ clientId, request });
      if (request.requestPath.startsWith('/api/token/')) {
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            data: {
              items: [{ key: clientId === 'chrome-zrf' ? 'abcd**********wxyz' : 'edge**********acct' }],
              total: 1,
            },
          }),
        };
      }
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          data: clientId === 'chrome-zrf'
            ? { id: 42, quota: 45_000_000, used_quota: 5_000_000 }
            : { id: 99, quota: 90_000_000, used_quota: 10_000_000 },
        }),
      };
    },
  }, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: { name: 'unlimited', unlimited_quota: true, total_available: 0, total_used: 0, total_granted: 0 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'welfare-account-a', name: '无名公益站-zrf', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://welfare.0xpsyche.me', baseUrl: '',
  });

  assert.equal(result.source, 'welfare_account');
  assert.equal(result.usage.remaining, 90);
  assert.equal(result.usage.used, 10);
  assert.equal(result.usage.total, 100);
  assert.equal(result.usage.extra, '已通过 Chrome 核验此 API Key 所属账号');
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.deepEqual(browserCalls.map(call => `${call.clientId}:${call.request.requestPath}`).sort(), [
    'chrome-zrf:/api/token/?p=1&size=100',
    'chrome-zrf:/api/user/self',
    'edge-account:/api/token/?p=1&size=100',
    'edge-account:/api/user/self',
  ]);
  assert.ok(browserCalls.every(call => !JSON.stringify(call).includes('abcd12345678wxyz')));
});

test('welfare unlimited keys reject a different account on the same website origin', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientId: 'edge-account', browser: 'Edge', hasSession: true },
      { clientId: 'chrome-other', browser: 'Chrome', hasSession: true },
    ],
    async queryJsonOnClient(_clientId, request) {
      return {
        status: 200,
        text: JSON.stringify(request.requestPath.startsWith('/api/token/')
          ? { success: true, data: { items: [{ key: 'other**********acct' }], total: 1 } }
          : { success: true, data: { id: 99, quota: 90_000_000, used_quota: 10_000_000 } }),
      };
    },
  }, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: { name: 'unlimited', unlimited_quota: true, total_available: 0, total_used: 0, total_granted: 0 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'welfare-account-b', name: '无名公益站-zrf', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://welfare.0xpsyche.me', baseUrl: '',
  });

  assert.equal(result.usage, undefined);
  assert.equal(result.accountMismatch, true);
  assert.equal(result.loginRequired, true);
  assert.equal(result.websiteLoginRequired, true);
  assert.match(result.message, /都不包含/);
  assert.match(result.message, /无名公益站-zrf/);
});

test('freely finite API keys show only the API key quota in USD', async () => {
  const calls = [];
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { browserCalls += 1; throw new Error('finite keys must not query the browser'); },
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      if (String(url).endsWith('/api/status')) {
        return new Response(JSON.stringify(jianzhileStatusPayload({ quota_display_type: 'USD', usd_exchange_rate: 7.3 })), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: true,
        data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
      }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'freely-finite', name: 'freely的', websiteUrl: 'https://free.lyclaude.site', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://free.lyclaude.site/v1', baseUrl: '',
  });

  assert.equal(result.source, 'freely_api_key');
  assert.equal(result.usage.remaining, 8);
  assert.equal(result.usage.used, 2);
  assert.equal(result.usage.total, 10);
  assert.equal(result.usage.unit, 'USD');
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
  assert.equal(browserCalls, 0);
  assert.deepEqual(calls, [
    { url: 'https://free.lyclaude.site/api/usage/token/', authorization: 'Bearer private-key' },
    { url: 'https://free.lyclaude.site/api/status', authorization: undefined },
  ]);
});

test('muyuan finite API keys use the standard New API token endpoint', async () => {
  const directCalls = [];
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { browserCalls += 1; throw new Error('direct New API results must not use the browser'); },
  }, {
    fetchImpl: async (url, options) => {
      directCalls.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify(String(url).endsWith('/api/status')
        ? jianzhileStatusPayload()
        : {
            code: true,
            data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
          }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'muyuan-finite', name: '君的公益', websiteUrl: '', usage: { code: 'stale /v1/user/balance script' }, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: 'https://muyuan.do/v1',
  });

  assert.equal(result.source, 'muyuan_api_key');
  assert.equal(result.usage.remaining, 8);
  assert.equal(result.usage.used, 2);
  assert.equal(result.usage.total, 10);
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
  assert.equal(browserCalls, 0);
  assert.deepEqual(directCalls, [
    { url: 'https://muyuan.do/api/usage/token/', authorization: 'Bearer private-key' },
    { url: 'https://muyuan.do/api/status', authorization: undefined },
  ]);
  assert.doesNotMatch(directCalls.map(call => call.url).join(' '), /user\/balance/);
});

test('muyuan finite API keys fall back to the allowlisted browser on Cloudflare', async () => {
  const directCalls = [];
  const browserCalls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson(request) {
      browserCalls.push(request);
      return {
        status: 200,
        text: JSON.stringify(request.requestPath === '/api/status'
          ? jianzhileStatusPayload()
          : {
              code: true,
              data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
            }),
      };
    },
  }, {
    fetchImpl: async url => {
      directCalls.push(String(url));
      return new Response('<html>Cloudflare challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    },
  });

  const result = await engine.query({
    id: 'muyuan-waf', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.source, 'muyuan_browser');
  assert.equal(result.usage.remaining, 8);
  assert.equal(result.usage.total, 10);
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
  assert.deepEqual(directCalls, [
    'https://muyuan.do/api/usage/token/',
    'https://muyuan.do/api/status',
  ]);
  assert.equal(browserCalls.length, 2);
  assert.deepEqual(browserCalls.map(call => ({
    baseUrl: call.baseUrl,
    requestPath: call.requestPath,
    authorization: call.headers.Authorization,
  })), [
    { baseUrl: 'https://muyuan.do', requestPath: '/api/usage/token/', authorization: 'Bearer private-key' },
    { baseUrl: 'https://muyuan.do', requestPath: '/api/status', authorization: undefined },
  ]);
});

test('muyuan unlimited API keys use the logged-in New API account total', async () => {
  const { broker, calls: browserCalls } = twoBrowserNewApiBroker();
  const engine = new ProviderQueryEngine({}, broker, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: { name: 'unlimited', unlimited_quota: true, total_available: 0, total_used: 6_000_000, total_granted: 0 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'muyuan-unlimited', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.source, 'muyuan_account');
  assert.equal(result.usage.remaining, 90);
  assert.equal(result.usage.used, 12, 'the key counter is authoritative when the account counter is lower');
  assert.equal(result.usage.total, 102);
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.match(result.usage.extra, /已通过 Chrome 核验/);
  assert.deepEqual(browserCalls.map(call => `${call.clientRef}:${call.request.requestPath}`).sort(), [
    'chrome-account:/api/token/?p=1&size=100',
    'chrome-account:/api/user/self',
    'edge-account:/api/token/?p=1&size=100',
    'edge-account:/api/user/self',
  ]);
});

test('New API account ownership probes browser clients serially to avoid same-origin WAF', async () => {
  const { broker, metrics } = twoBrowserNewApiBroker({ requestDelayMs: 5 });
  const engine = new ProviderQueryEngine({}, broker, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: { name: 'unlimited', unlimited_quota: true, total_available: 0, total_used: 6_000_000, total_granted: 0 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'muyuan-serialized', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.equal(metrics.maximum, 1);
});

test('muyuan browser WAF failures expose the official verification action', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 403, text: '<html>Cloudflare challenge</html>' };
    },
  }, {
    fetchImpl: async () => new Response('<html>Cloudflare challenge</html>', { status: 403 }),
  });

  const result = await engine.query({
    id: 'muyuan-blocked', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.usage, undefined);
  assert.equal(result.source, 'muyuan_browser');
  assert.equal(result.loginRequired, true);
  assert.equal(result.websiteLoginRequired, true);
  assert.match(result.message, /Cloudflare\/WAF/);
});

test('muyuan WAF failures preserve real local usage without inventing balance totals', async () => {
  const engine = new ProviderQueryEngine({
    getLocalUsage() { return { requestCount: 102, totalCost: 10.611222 }; },
  }, {
    isConnected: () => true,
    async queryJson() { return { status: 0, text: '', error: 'Failed to fetch' }; },
  }, {
    fetchImpl: async () => new Response('<html>Cloudflare challenge</html>', { status: 403 }),
  });

  const result = await engine.query({
    id: 'muyuan-local', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.source, 'muyuan_local_usage');
  assert.equal(result.degraded, true);
  assert.equal(result.websiteLoginRequired, true);
  assert.equal(result.usage.used, 10.611222);
  assert.equal(result.usage.remaining, null);
  assert.equal(result.usage.total, null);
  assert.match(result.message, /本地已用估算/);
});

test('muyuan local fallback does not claim website logout for a pure transport failure', async () => {
  const engine = new ProviderQueryEngine({
    getLocalUsage() { return { requestCount: 12, totalCost: 1.25 }; },
  }, {
    isConnected: () => true,
    async queryJson() {
      return { status: 0, text: '', permissionRequired: true, error: '余额伴侣缺少供应商网站查询权限' };
    },
  }, {
    fetchImpl: async () => { throw new Error('connect failed'); },
  });

  const result = await engine.query({
    id: 'muyuan-network', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.source, 'muyuan_local_usage');
  assert.equal(result.degraded, true);
  assert.equal(result.loginRequired, false);
  assert.equal(result.websiteLoginRequired, false);
  assert.equal(result.usage.used, 1.25);
  assert.match(result.message, /本地已用估算/);
});

test('muyuan browser permission failures override an earlier direct WAF classification', async () => {
  const engine = new ProviderQueryEngine({
    getLocalUsage() { return { requestCount: 12, totalCost: 1.25 }; },
  }, {
    isConnected: () => true,
    async queryJson() {
      return { status: 0, text: '', permissionRequired: true, error: '余额伴侣缺少供应商网站查询权限' };
    },
  }, {
    fetchImpl: async () => new Response('<html>Cloudflare challenge</html>', { status: 403 }),
  });

  const result = await engine.query({
    id: 'muyuan-permission', name: '君的公益', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://muyuan.do/v1', baseUrl: '',
  });

  assert.equal(result.source, 'muyuan_local_usage');
  assert.equal(result.loginRequired, false);
  assert.equal(result.websiteLoginRequired, false);
  assert.match(result.message, /网站查询权限/);
  assert.match(result.message, /本地已用估算/);
});

test('freely unlimited API keys switch to the logged-in account total quota', async () => {
  const { broker, calls: browserCalls } = twoBrowserNewApiBroker();
  const engine = new ProviderQueryEngine({}, broker, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload({ quota_display_type: 'USD', usd_exchange_rate: 7.3 })
      : {
          code: true,
          data: { name: 'unlimited', unlimited_quota: true, total_available: 0, total_used: 0, total_granted: 0 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'freely-unlimited', name: 'freely的', websiteUrl: 'https://free.lyclaude.site', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://free.lyclaude.site/v1', baseUrl: '',
  });

  assert.equal(result.source, 'freely_account');
  assert.equal(result.usage.remaining, 90);
  assert.equal(result.usage.used, 10);
  assert.equal(result.usage.total, 100);
  assert.equal(result.usage.unit, 'USD');
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.match(result.usage.extra, /已通过 Chrome 核验/);
  assert.deepEqual(browserCalls.map(call => `${call.clientRef}:${call.request.requestPath}`).sort(), [
    'chrome-account:/api/token/?p=1&size=100',
    'chrome-account:/api/user/self',
    'edge-account:/api/token/?p=1&size=100',
    'edge-account:/api/user/self',
  ]);
});

test('freely unlimited API keys request website session sync instead of using placeholders', async () => {
  const engine = new ProviderQueryEngine({}, { isConnected: () => false }, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload({ quota_display_type: 'USD', usd_exchange_rate: 7.3 })
      : {
          code: true,
          data: { unlimited_quota: true, total_available: 0, total_used: 0, total_granted: 0 },
        }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'freely-offline', name: 'freely的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://free.lyclaude.site/v1', baseUrl: '',
  });

  assert.equal(result.usage, undefined);
  assert.equal(result.source, 'freely_account');
  assert.equal(result.loginRequired, true);
  assert.equal(result.sessionSyncRequired, true);
  assert.doesNotMatch(result.message, /100000000/);
});

test('a Packy-like display name never redirects its API key to the fixed Packy endpoint', async () => {
  const calls = [];
  const engine = new ProviderQueryEngine({ getLocalUsage: () => ({ requestCount: 0, totalCost: 0 }) }, {}, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response('{"data":[]}', { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'renamed', name: 'Packy 临时备份', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://unrelated.example/v1', baseUrl: '',
  });

  assert.equal(result.source, 'api_health_and_local_usage');
  assert.match(result.usage.extra, /API Key.*无需官网登录/);
  assert.deepEqual(calls, [{
    url: 'https://unrelated.example/v1/models',
    authorization: 'Bearer private-key',
  }]);
  assert.doesNotMatch(calls[0].url, /packyapi\.com/);
});

test('an explicit New API balance template probes only an unknown provider configured origin', async () => {
  const calls = [];
  const provider = {
    id: 'new-relay', name: '新中转', websiteUrl: 'https://relay.example', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://relay.example/v1', baseUrl: '',
  };
  const description = describeProviderQuery(provider, 'new-api-key-quota');
  assert.equal(description.templateId, 'new-api-key-quota');
  assert.equal(description.requestUrl, 'https://relay.example/api/usage/token/');
  assert.equal(loginConfiguration(provider, 'new-api-key-quota').baseUrl, 'https://relay.example');

  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      const payload = String(url).endsWith('/api/status')
        ? jianzhileStatusPayload()
        : {
            code: true,
            data: { name: 'finite', unlimited_quota: false, total_available: 4_000_000, total_used: 1_000_000, total_granted: 5_000_000 },
          };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const result = await engine.query(provider, { balanceTemplateId: 'new-api-key-quota', bypassCache: true });
  assert.equal(result.source, 'new_api_key');
  assert.equal(result.usage.remaining, 8);
  assert.deepEqual(calls, [
    { url: 'https://relay.example/api/usage/token/', authorization: 'Bearer private-key' },
    { url: 'https://relay.example/api/status', authorization: undefined },
  ]);
});

test('an unlimited unknown New API key preserves schema validation when browser account access is unavailable', async () => {
  const provider = {
    id: 'unlimited-new-relay', name: '新无限额度中转', websiteUrl: 'https://relay.example', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: 'https://relay.example/v1', baseUrl: '',
  };
  const engine = new ProviderQueryEngine({}, { isConnected: () => false }, {
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? jianzhileStatusPayload()
      : {
          code: true,
          data: {
            name: 'unlimited', unlimited_quota: true, total_available: 0, total_used: 0, total_granted: 0,
          },
        }), { status: 200 }),
  });

  const result = await engine.query(provider, { balanceTemplateId: 'new-api-key-quota', bypassCache: true });

  assert.equal(result.schemaValidated, true);
  assert.equal(result.sessionSyncRequired, true);
  assert.equal(result.loginRequired, true);
  assert.equal(result.usage, undefined);
});

test('an explicit DeepSeek template never falls back to the fixed DeepSeek origin for a generic provider', async () => {
  let requests = 0;
  const provider = {
    id: 'missing-base', name: '新中转', websiteUrl: '', usage: null, auth: {},
    apiKey: 'private-key', apiBaseUrl: '', baseUrl: '',
  };
  assert.equal(describeProviderQuery(provider, 'deepseek-balance').requestUrl, '');
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async () => { requests += 1; throw new Error('must not request'); },
  });
  await assert.rejects(
    engine.query(provider, { balanceTemplateId: 'deepseek-balance', bypassCache: true }),
    /安全 Base URL/,
  );
  assert.equal(requests, 0);
});

test('provider queries surface incomplete balance payloads instead of turning them into zero', async () => {
  const browserEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { return { status: 200, text: '{"success":true,"data":{"used_quota":0}}' }; },
  });
  await assert.rejects(browserEngine.query({
    id: 'any-invalid', name: 'Any', websiteUrl: '', usage: null, auth: {}, apiKey: '', apiBaseUrl: 'https://anyrouter.top',
  }), /quota/);

  const deepSeekEngine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async () => new Response('{"is_available":true}', { status: 200 }),
  });
  await assert.rejects(deepSeekEngine.query({
    id: 'deepseek-invalid', name: 'DeepSeek', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://api.deepseek.com',
  }), /balance_infos/);

  const packyEngine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async () => new Response('{"code":true,"data":{"total_available":0}}', { status: 200 }),
  });
  await assert.rejects(packyEngine.query({
    id: 'packy-invalid', name: 'Renamed', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://www.packyapi.com/v1',
  }), /total_used/);
});

test('transient provider failures stay retryable while WAF challenges request an explicit website visit', async () => {
  const provider = { id: 'any', name: 'any的国内镜像', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://anyrouter.top' };
  const timeoutEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { throw new Error('第三方网站余额查询超时'); },
  });
  await assert.rejects(timeoutEngine.query(provider), /查询超时/);

  const upstreamEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 200, text: '{"success":false,"message":"temporary upstream error"}' };
    },
  });
  await assert.rejects(upstreamEngine.query(provider), /temporary upstream error/);

  const wafEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 403, text: '<html>Cloudflare challenge</html>' };
    },
  });
  const waf = await wafEngine.query(provider);
  assert.equal(waf.loginRequired, true);
  assert.equal(waf.websiteLoginRequired, true);
  assert.match(waf.message, /官网认证/);

  const htmlEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 200, text: '<html><body>Access unavailable</body></html>' };
    },
  });
  const html = await htmlEngine.query(provider);
  assert.equal(html.websiteLoginRequired, true);
  assert.match(html.message, /官网登录/);

  const frameEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { throw new Error('Frame with ID 0 is showing error page'); },
  });
  const frame = await frameEngine.query(provider);
  assert.equal(frame.websiteLoginRequired, true);
  assert.match(frame.message, /官网登录/);

  const structuredWafEngine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 403, text: '{"success":false,"message":"Cloudflare challenge required"}' };
    },
  });
  const structuredWaf = await structuredWafEngine.query(provider);
  assert.equal(structuredWaf.websiteLoginRequired, true);
  assert.match(structuredWaf.message, /WAF/);
});

test('browser transport failures do not claim that the existing website session logged out', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 0, text: '', error: 'Failed to fetch' };
    },
  });

  await assert.rejects(engine.query({
    id: 'agent-transport', name: 'agentrouter', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://agentrouter.org',
  }), /浏览器查询失败.*Failed to fetch/);
});

test('browser callback marks only explicit authentication failures as login-required', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 200, text: '{"success":false,"message":"not logged in"}' };
    },
  });
  const result = await engine.query({
    id: 'any', name: 'any的国内镜像', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://anyrouter.top',
  });

  assert.equal(result.loginRequired, true);
  assert.equal(result.source, 'browser_session');
  assert.equal(result.websiteLoginRequired, true);
});

test('missing persisted New API identity requests one-time session sync instead of claiming logout', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return { status: 401, text: '{"success":false,"message":"unauthorized"}', identityMissing: true };
    },
  });

  const result = await engine.query({
    id: 'any', name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://anyrouter.top',
  });

  assert.equal(result.loginRequired, true);
  assert.equal(result.sessionSyncRequired, true);
  assert.match(result.message, /同步现有会话/);
});

test('New API session repair preserves the companion one-time sync result', async () => {
  let received = null;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async openLogin(request) {
      received = request;
      return { synced: true, opened: false, origin: 'https://anyrouter.top' };
    },
  });

  const result = await engine.openLogin({ id: 'any', name: 'any的国外我自己的', apiBaseUrl: 'https://anyrouter.top/v1' });

  assert.equal(received.userHeader, 'New-Api-User');
  assert.equal(result.synced, true);
  assert.equal(result.opened, false);
});

test('website authentication targets the browser selected in Hub', async () => {
  let targeted = null;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientId: 'edge-account', clientRef: 'edge-ref-one', browser: 'Edge' },
      { clientId: 'chrome-account', clientRef: 'chrome-ref-one', browser: 'Chrome' },
    ],
    async openLoginOnClient(clientRef, request) {
      targeted = { clientRef, request };
      return { opened: true, origin: 'https://welfare.0xpsyche.me' };
    },
    async openLogin() {
      throw new Error('generic browser routing must not be used');
    },
  });

  const result = await engine.openLogin({
    id: 'welfare', name: '无名公益站-zrf', apiBaseUrl: 'https://welfare.0xpsyche.me/v1',
  }, { clientRef: 'chrome-ref-one' });

  assert.equal(targeted.clientRef, 'chrome-ref-one');
  assert.equal(targeted.request.loginUrl, 'https://welfare.0xpsyche.me/login');
  assert.equal(result.browser, 'Chrome');
  assert.equal(result.opened, true);
});

test('WAF balance queries use a connected companion after host restart even before a session hint is restored', async () => {
  let loginCalls = 0;
  let queryCalls = 0;
  const broker = {
    hasSession: () => false,
    isConnected: () => true,
    async queryJson() {
      queryCalls += 1;
      return { status: 200, text: '{"success":true,"data":{"quota":5000000,"used_quota":500000,"group":"vip"}}' };
    },
    async openLogin() { loginCalls += 1; },
  };
  const engine = new ProviderQueryEngine({}, broker, { fetchImpl: async () => { throw new Error('model API must not run while the browser callback is connected'); } });
  const provider = { id: 'agent', name: 'agentrouter', websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://agentrouter.org' };

  const result = await engine.query(provider);

  assert.equal(result.source, 'browser_session');
  assert.equal(result.usage.remaining, 10);
  assert.equal(queryCalls, 1);
  assert.equal(loginCalls, 0);
});

test('browser-only New API queries use the browser account that owns the provider API key', async () => {
  const { broker, calls } = twoBrowserNewApiBroker();
  const engine = new ProviderQueryEngine({}, broker);

  const result = await engine.query({
    id: 'agent-owned', name: 'agentrouter', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://agentrouter.org', baseUrl: '',
  });

  assert.equal(result.source, 'browser_session');
  assert.equal(result.usage.remaining, 90);
  assert.equal(result.usage.used, 10);
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.match(result.usage.extra, /已通过 Chrome 核验/);
  assert.deepEqual(calls.map(call => `${call.clientRef}:${call.request.requestPath}`).sort(), [
    'chrome-account:/api/token/?p=1&size=100',
    'chrome-account:/api/user/self',
    'edge-account:/api/token/?p=1&size=100',
    'edge-account:/api/user/self',
  ]);
});

test('AnyRouter Edge WAF is not misreported as the API key belonging to neither browser', async () => {
  const clientCalls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true },
      { clientRef: 'chrome-other', browser: 'Chrome', hasSession: false },
    ],
    async queryJsonOnClient(clientRef, request) {
      clientCalls.push(clientRef);
      if (clientRef === 'edge-anyrouter') {
        return {
          status: 403,
          text: 'Cloudflare challenge response',
          interactivePage: true,
          cfMitigated: true,
        };
      }
      return {
        status: 200,
        text: JSON.stringify(request.requestPath.startsWith('/api/token/')
          ? { success: true, data: { items: [{ key: 'other**********acct' }], total: 1 } }
          : { success: true, data: { id: 99, quota: 90_000_000, used_quota: 10_000_000 } }),
      };
    },
  });

  const result = await engine.query({
    id: 'anyrouter-edge', name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://anyrouter.top/v1', baseUrl: '',
  });

  assert.equal(result.accountMismatch, undefined);
  assert.equal(result.websiteLoginRequired, true);
  assert.match(result.message, /WAF/);
  assert.deepEqual(clientCalls, ['edge-anyrouter']);
});

test('AnyRouter uses its sole validated Edge session when the deployment hides the token list', async () => {
  const clientCalls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true },
      { clientRef: 'chrome-unrelated', browser: 'Chrome', hasSession: false },
    ],
    async queryJsonOnClient(clientRef, request) {
      clientCalls.push(`${clientRef}:${request.requestPath}`);
      if (clientRef !== 'edge-anyrouter') throw new Error('unrelated Chrome must not be queried');
      return {
        status: 200,
        text: JSON.stringify(request.requestPath.startsWith('/api/token/')
          ? { success: true, data: [] }
          : { success: true, data: { id: 42, quota: 45_000_000, used_quota: 5_000_000 } }),
      };
    },
  });

  const result = await engine.query({
    id: 'anyrouter-edge-empty-list', name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-abcd12345678wxyz', apiBaseUrl: 'https://anyrouter.top/v1', baseUrl: '',
  });

  assert.equal(result.usage.accountBrowser, 'Edge');
  assert.match(result.usage.extra, /唯一的 Edge 有效会话/);
  assert.deepEqual(clientCalls, [
    'edge-anyrouter:/api/user/self',
    'edge-anyrouter:/api/token/?p=1&size=100',
  ]);
});

test('AnyRouter hidden token list requires binding when multiple provider credentials exist', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true },
      { clientRef: 'chrome-unrelated', browser: 'Chrome', hasSession: false },
    ],
    async queryJsonOnClient(_clientRef, request) {
      return {
        status: 200,
        text: JSON.stringify(request.requestPath.startsWith('/api/token/')
          ? { success: true, data: [] }
          : { success: true, data: { id: 42, quota: 45_000_000, used_quota: 5_000_000 } }),
      };
    },
  });

  const result = await engine.query({
    id: 'anyrouter-binding-required', name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-second-account', apiBaseUrl: 'https://anyrouter.top/v1', baseUrl: '',
  }, { allowSoleSessionFallback: false });

  assert.equal(result.usage, undefined);
  assert.equal(result.accountBindingRequired, true);
  assert.match(result.message, /明确绑定 Edge 或 Chrome/);
});

test('AnyRouter explicit account binding targets one browser and skips the hidden token list', async () => {
  const calls = [];
  const accounts = {
    'edge-anyrouter': { id: 11, quota: 90_000_000, used_quota: 10_000_000 },
    'chrome-anyrouter': { id: 22, quota: 45_000_000, used_quota: 5_000_000 },
  };
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true },
      { clientRef: 'chrome-anyrouter', browser: 'Chrome', hasSession: true },
    ],
    async queryJsonOnClient(clientRef, request) {
      calls.push(`${clientRef}:${request.requestPath}`);
      return { status: 200, text: JSON.stringify({ success: true, data: accounts[clientRef] }) };
    },
  });
  const provider = {
    id: 'anyrouter-bound', name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-account-two', apiBaseUrl: 'https://anyrouter.top/v1', baseUrl: '',
  };

  const bound = await engine.bindBrowserAccount(provider, { clientRef: 'chrome-anyrouter' });
  assert.equal(bound.failure, undefined);
  assert.equal(bound.binding.browser, 'Chrome');
  assert.equal(bound.binding.clientRef, 'chrome-anyrouter');
  assert.match(bound.binding.accountRef, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(bound.binding, 'accountId'), false);
  assert.equal(Object.hasOwn(bound.binding, 'userId'), false);
  assert.notEqual(bound.binding.accountRef, '22', 'the numeric account id must not be persisted');

  calls.length = 0;
  const result = await engine.query(provider, { accountBinding: bound.binding });

  assert.equal(result.source, 'browser_session');
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.match(result.usage.extra, /绑定的 Chrome AnyRouter 账号/);
  assert.deepEqual(calls, ['chrome-anyrouter:/api/user/self']);
});

test('AnyRouter binding rejects a browser account switch without retaining the old account result', async () => {
  let accountId = 22;
  const calls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientRef: 'chrome-anyrouter', browser: 'Chrome', hasSession: true },
      { clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true },
    ],
    async queryJsonOnClient(clientRef, request) {
      calls.push(`${clientRef}:${request.requestPath}`);
      return {
        status: 200,
        text: JSON.stringify({ success: true, data: { id: accountId, quota: 45_000_000, used_quota: 5_000_000 } }),
      };
    },
  });
  const provider = {
    id: 'anyrouter-switched', name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'sk-account-two', apiBaseUrl: 'https://anyrouter.top/v1', baseUrl: '',
  };
  const bound = await engine.bindBrowserAccount(provider, { clientRef: 'chrome-anyrouter' });
  accountId = 33;
  calls.length = 0;

  const result = await engine.query(provider, { accountBinding: bound.binding });

  assert.equal(result.usage, undefined);
  assert.equal(result.accountBindingMismatch, true);
  assert.equal(result.invalidateUsage, true);
  assert.match(result.message, /账号已变化.*重新绑定/);
  assert.deepEqual(calls, ['chrome-anyrouter:/api/user/self']);
});

test('AnyRouter shared API keys do not reuse results across different explicit bindings', async () => {
  let calls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    listQueryClients: () => [
      { clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true },
      { clientRef: 'chrome-anyrouter', browser: 'Chrome', hasSession: true },
    ],
    async queryJsonOnClient(clientRef) {
      calls += 1;
      const data = clientRef === 'edge-anyrouter'
        ? { id: 11, quota: 90_000_000, used_quota: 10_000_000 }
        : { id: 22, quota: 45_000_000, used_quota: 5_000_000 };
      return { status: 200, text: JSON.stringify({ success: true, data }) };
    },
  });
  const base = {
    name: 'any的国外我自己的', websiteUrl: '', usage: null, auth: {},
    apiKey: 'same-key', apiBaseUrl: 'https://anyrouter.top/v1', baseUrl: '',
  };
  const edgeProvider = { ...base, id: 'edge-provider' };
  const chromeProvider = { ...base, id: 'chrome-provider' };
  const edge = await engine.bindBrowserAccount(edgeProvider, { clientRef: 'edge-anyrouter' });
  const chrome = await engine.bindBrowserAccount(chromeProvider, { clientRef: 'chrome-anyrouter' });
  calls = 0;

  const [edgeResult, chromeResult] = await Promise.all([
    engine.query(edgeProvider, { accountBinding: edge.binding }),
    engine.query(chromeProvider, { accountBinding: chrome.binding }),
  ]);

  assert.equal(calls, 2);
  assert.equal(edgeResult.usage.accountBrowser, 'Edge');
  assert.equal(chromeResult.usage.accountBrowser, 'Chrome');
  assert.notEqual(edgeResult.usage.remaining, chromeResult.usage.remaining);
});

test('AnyRouter provider copies share one browser callback in the same Edge profile', async () => {
  let queryCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      queryCalls += 1;
      return { status: 200, text: '{"success":true,"data":{"quota":5000000,"used_quota":500000}}' };
    },
  });
  const base = { websiteUrl: '', usage: null, auth: {}, apiKey: 'key', apiBaseUrl: 'https://anyrouter.top' };

  const [domestic, foreign] = await Promise.all([
    engine.query({ ...base, id: 'domestic', name: 'any的国内镜像' }),
    engine.query({ ...base, id: 'foreign', name: 'any的国外我自己的' }),
  ]);

  assert.equal(queryCalls, 1);
  assert.equal(domestic.usage.providerId, 'domestic');
  assert.equal(foreign.usage.providerId, 'foreign');
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

test('OpenAI session fallback uses the browser logged into the configured account', async () => {
  const sessionCalls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    hasSession: () => true,
    listQueryClients: () => [
      { clientId: 'edge-openai', clientRef: 'edge-openai', browser: 'Edge', hasSession: true },
      { clientId: 'chrome-openai', clientRef: 'chrome-openai', browser: 'Chrome', hasSession: true },
    ],
    async queryJson(request) {
      sessionCalls.push({ clientRef: 'generic', request });
      return {
        status: 200,
        text: JSON.stringify({ accessToken: 'edge-token', account: { id: 'edge-account' } }),
      };
    },
    async queryJsonOnClient(clientRef, request) {
      sessionCalls.push({ clientRef, request });
      const chrome = clientRef === 'chrome-openai';
      return {
        status: 200,
        text: JSON.stringify({
          accessToken: chrome ? 'chrome-token' : 'edge-token',
          account: { id: chrome ? 'target-account' : 'edge-account' },
        }),
      };
    },
  }, {
    whamBrowserRaceDelayMs: 50,
    fetchImpl: async (_url, options) => {
      if (options.headers.Authorization === 'Bearer expired-token') {
        return new Response('{"error":"expired"}', { status: 401 });
      }
      const usedPercent = options.headers['ChatGPT-Account-Id'] === 'target-account' ? 40 : 10;
      return new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000 } },
      }), { status: 200 });
    },
  });

  const result = await engine.query({
    id: 'openai-owned', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'target-account', access_token: 'expired-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(result.source, 'browser_session');
  assert.equal(result.usage.remaining, 60);
  assert.equal(result.usage.accountBrowser, 'Chrome');
  assert.match(result.usage.extra, /Chrome.*OpenAI 账号/);
  assert.deepEqual(sessionCalls.map(call => call.clientRef).sort(), ['chrome-openai', 'edge-openai']);
});

test('OpenAI WHAM failures use one fast probe and temporarily bypass repeated direct attempts', async () => {
  let now = 1_000;
  let directCalls = 0;
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      browserCalls += 1;
      return {
        status: 200,
        text: JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
        }),
      };
    },
  }, {
    now: () => now,
    whamDirectBackoffMs: 100,
    fetchImpl: async () => {
      directCalls += 1;
      throw new Error('node transport unavailable');
    },
  });
  const provider = (id, accountId) => ({
    id,
    name: `OpenAI Official ${id}`,
    websiteUrl: 'https://chatgpt.com/codex',
    usage: null,
    auth: { tokens: { account_id: accountId, access_token: `private-token-${id}` } },
    apiKey: '',
    apiBaseUrl: '',
    baseUrl: '',
  });

  const first = await engine.query(provider('one', 'account-one'));
  const second = await engine.query(provider('two', 'account-two'));

  assert.equal(first.source, 'openai_wham_browser');
  assert.equal(second.source, 'openai_wham_browser');
  assert.equal(directCalls, 1, 'the active backoff must skip the second direct probe');
  assert.equal(browserCalls, 2);

  now += 100;
  const third = await engine.query(provider('three', 'account-three'));

  assert.equal(third.source, 'openai_wham_browser');
  assert.equal(directCalls, 2, 'direct probing must resume after the backoff expires');
  assert.equal(browserCalls, 3);
});

test('OpenAI WHAM direct probing is time-bounded when a browser fallback is available', async () => {
  let directAborted = false;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      return {
        status: 200,
        text: JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
        }),
      };
    },
  }, {
    homeDir: 'Z:\\missing-home',
    whamBrowserProbeTimeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('direct probe did not abort')), 250);
      const abort = () => {
        clearTimeout(keepAlive);
        directAborted = true;
        reject(new Error('direct probe timed out'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }),
  });

  const result = await engine.query({
    id: 'openai-timeout', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(directAborted, true);
  assert.equal(result.source, 'openai_wham_browser');
  assert.equal(result.usage.remaining, 90);
});

test('OpenAI WHAM starts the browser path before a stalled direct probe expires', async () => {
  let directAborted = false;
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() {
      browserCalls += 1;
      return {
        status: 200,
        text: JSON.stringify({
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 15, limit_window_seconds: 18_000 } },
        }),
      };
    },
  }, {
    whamBrowserProbeTimeoutMs: 1_000,
    whamBrowserRaceDelayMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        directAborted = true;
        reject(options.signal.reason || new Error('aborted'));
      }, { once: true });
    }),
  });

  const result = await engine.query({
    id: 'openai-race', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(browserCalls, 1);
  assert.equal(directAborted, true, 'the winning browser callback must cancel the stalled direct request');
  assert.equal(result.source, 'openai_wham_browser');
  assert.equal(result.usage.remaining, 85);
});

test('a fast OpenAI direct response wins without starting a browser callback', async () => {
  let browserCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { browserCalls += 1; throw new Error('browser path should remain idle'); },
  }, {
    whamBrowserRaceDelayMs: 20,
    fetchImpl: async () => new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } },
    }), { status: 200 }),
  });

  const result = await engine.query({
    id: 'openai-direct', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(browserCalls, 0);
  assert.equal(result.source, 'openai_wham');
});

test('an early invalid browser response does not cancel a later valid OpenAI direct result', async () => {
  let directAborted = false;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { return { status: 403, text: '<html>challenge</html>' }; },
  }, {
    whamBrowserRaceDelayMs: 2,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18_000 } },
      }), { status: 200 })), 15);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        directAborted = true;
        reject(options.signal.reason || new Error('aborted'));
      }, { once: true });
    }),
  });

  const result = await engine.query({
    id: 'openai-invalid-browser', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(directAborted, false);
  assert.equal(result.source, 'openai_wham');
  assert.equal(result.usage.remaining, 92);
});

test('an HTTP 200 browser error payload never masquerades as full OpenAI quota', async () => {
  let directAborted = false;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    hasSession: () => false,
    async queryJson() { return { status: 200, text: '{"error":"upstream failure"}' }; },
  }, {
    whamBrowserRaceDelayMs: 2,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18_000 } },
      }), { status: 200 })), 15);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        directAborted = true;
        reject(options.signal.reason || new Error('aborted'));
      }, { once: true });
    }),
  });

  const result = await engine.query({
    id: 'openai-json-error', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(directAborted, false);
  assert.equal(result.source, 'openai_wham');
  assert.equal(result.usage.remaining, 92);
});

test('only a valid WHAM quota payload can produce OpenAI usage', async () => {
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    hasSession: () => false,
    async queryJson() { return { status: 200, text: '{"error":"upstream failure"}' }; },
  }, {
    whamBrowserRaceDelayMs: 1,
    fetchImpl: async () => { throw new Error('direct unavailable'); },
  });

  const result = await engine.query({
    id: 'openai-invalid-only', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });

  assert.equal(result.loginRequired, false);
  assert.equal(result.usage, undefined);
});

test('OpenAI transient WHAM failures stay retryable instead of becoming login-required', async () => {
  for (const status of [429, 503]) {
    const engine = new ProviderQueryEngine({}, {}, {
      fetchImpl: async () => new Response(JSON.stringify({ error: 'temporary upstream failure' }), { status }),
    });

    const result = await engine.query({
      id: `openai-transient-${status}`, name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
      auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
    });

    assert.equal(result.loginRequired, false, `HTTP ${status} must remain retryable`);
    assert.equal(result.source, 'openai_wham');
    assert.match(result.message, new RegExp(String(status)));
    assert.equal(result.usage, undefined);
  }
});

test('OpenAI authentication failures remain login-required while browser transport errors do not', async () => {
  const authEngine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }),
  });
  const auth = await authEngine.query({
    id: 'openai-auth-failure', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });
  assert.equal(auth.loginRequired, true);

  let browserCalls = 0;
  const transportEngine = new ProviderQueryEngine({}, {
    hasSession: () => true,
    isConnected: () => true,
    async queryJson() {
      browserCalls += 1;
      throw new Error('browser transport unavailable');
    },
  }, {
    fetchImpl: async () => new Response('{"error":"upstream unavailable"}', { status: 503 }),
  });
  const transient = await transportEngine.query({
    id: 'openai-browser-transport', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex', usage: null,
    auth: { tokens: { account_id: 'account-one', access_token: 'private-token' } }, apiKey: '', apiBaseUrl: '', baseUrl: '',
  });
  assert.equal(browserCalls, 1, 'the secondary browser-session fallback should be attempted once');
  assert.equal(transient.loginRequired, false);
  assert.match(transient.message, /503/);
});

test('provider HTTP retries share one total deadline instead of resetting it per attempt', async () => {
  const attemptDurations = [];
  const totalTimeoutMs = 300;
  const startedAt = Date.now();
  await assert.rejects(fetchJson(async (_url, options) => {
    const attemptStartedAt = Date.now();
    return new Promise((_resolve, reject) => {
      const abort = () => {
        attemptDurations.push(Date.now() - attemptStartedAt);
        reject(options.signal.reason || new Error('timed out'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
  }, 'https://example.invalid/balance', {}, totalTimeoutMs, 2, null, 1));

  assert.equal(attemptDurations.length, 2);
  assert.ok(attemptDurations.every(duration => duration < 250), `attempts must split the total deadline: ${attemptDurations}`);
  assert.ok(Date.now() - startedAt < 450, 'the two attempts must not each receive the full deadline');
});

test('provider cancellation interrupts the retry backoff immediately', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const startedAt = Date.now();
  const pending = fetchJson(async () => {
    attempts += 1;
    return new Response('{"error":"busy"}', { status: 503 });
  }, 'https://example.invalid/balance', {}, 5_000, 3, controller.signal, 1_000);

  while (attempts === 0) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(new Error('cancelled during retry'));

  await assert.rejects(pending, /cancelled during retry/);
  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 300, 'abort must not wait for the one-second retry delay');
});

test('provider queries enforce one global deadline even when a transport ignores abort', async () => {
  const engine = new ProviderQueryEngine({}, {}, {
    providerQueryTimeoutMs: 15,
    fetchImpl: async () => new Promise(() => {}),
  });
  const startedAt = Date.now();

  await assert.rejects(engine.query({
    id: 'hung', name: 'DeepSeek', websiteUrl: '', usage: null, auth: {}, apiKey: 'private-key', apiBaseUrl: 'https://api.deepseek.com', baseUrl: '',
  }), /查询超过/);

  assert.ok(Date.now() - startedAt < 150);
});

test('a failed browser fallback does not suppress the next OpenAI direct probe', async () => {
  let directCalls = 0;
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    async queryJson() { throw new Error('browser transport unavailable'); },
  }, {
    fetchImpl: async () => {
      directCalls += 1;
      throw new Error('node transport unavailable');
    },
  });
  const provider = id => ({
    id,
    name: `OpenAI Official ${id}`,
    websiteUrl: 'https://chatgpt.com/codex',
    usage: null,
    auth: { tokens: { account_id: `account-${id}`, access_token: `private-token-${id}` } },
    apiKey: '',
    apiBaseUrl: '',
    baseUrl: '',
  });

  await assert.rejects(engine.query(provider('one')), /node transport unavailable/);
  await assert.rejects(engine.query(provider('two')), /node transport unavailable/);

  assert.equal(directCalls, 2);
});

test('overlapping OpenAI and CPA accounts reuse one successful WHAM query without caching credentials', async () => {
  let now = 1_000;
  let directCalls = 0;
  const engine = new ProviderQueryEngine({}, {}, {
    now: () => now,
    whamResultCacheMs: 100,
    fetchImpl: async () => {
      directCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
      }), { status: 200 });
    },
  });
  const provider = (id, token = 'shared-private-token') => ({
    id,
    name: `OpenAI Official ${id}`,
    websiteUrl: 'https://chatgpt.com/codex',
    usage: null,
    auth: { tokens: { account_id: 'shared-account', access_token: token } },
    apiKey: '',
    apiBaseUrl: '',
    baseUrl: '',
  });

  const [first, second] = await Promise.all([
    engine.query(provider('one')),
    engine.query(provider('two')),
  ]);
  const cached = await engine.query(provider('three'));

  assert.equal(directCalls, 1);
  assert.equal(first.usage.providerId, 'one');
  assert.equal(second.usage.providerId, 'two');
  assert.equal(cached.usage.providerId, 'three');

  now += 100;
  await engine.query(provider('after-expiry'));
  await engine.query(provider('rotated-token', 'new-private-token'));

  assert.equal(directCalls, 3, 'cache expiry and token rotation must each force a new WHAM query');
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
  assert.match(second.usage.extra, /API Key.*无需官网登录/);
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

  const first = await engine.query({ ...base, id: 'raw', name: '付费站', apiBaseUrl: 'https://rawchat.cn/codex', baseUrl: 'https://old-bridge.invalid' });
  const second = await engine.query({ ...base, id: 'copy', name: '付费站 copy', apiBaseUrl: 'https://sharedchat.top/codex', baseUrl: 'https://old-bridge.invalid' });

  assert.equal(requests, 1);
  assert.equal(first.usage.remaining, 9);
  assert.equal(first.usage.providerName, '付费站');
  assert.match(first.usage.extra, /API Key.*无需官网登录/);
  assert.equal(second.usage.providerId, 'copy');
  assert.equal(second.usage.providerName, '付费站 copy');
});

test('name-only paid-site providers never share cached results across unknown origins', async () => {
  const requests = [];
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async url => {
      requests.push(String(url));
      return new Response('{"status":"ok","balance_3h":4,"used_3h":1,"limit_3h":5,"balance_1d":9,"used_1d":1,"limit_1d":10}', { status: 200 });
    },
  });
  const base = { name: '付费站', websiteUrl: '', usage: null, auth: {}, apiKey: 'shared-key' };

  await engine.query({ ...base, id: 'first', apiBaseUrl: 'https://first.example/v1' });
  await engine.query({ ...base, id: 'second', apiBaseUrl: 'https://second.example/v1' });

  assert.deepEqual(requests, [
    'https://first.example/v1/user/balance',
    'https://second.example/v1/user/balance',
  ]);
});

test('manual window templates never share cached results across generic provider origins', async () => {
  const requests = [];
  const engine = new ProviderQueryEngine({}, {}, {
    fetchImpl: async url => {
      requests.push(String(url));
      return new Response('{"status":"ok","balance_3h":4,"used_3h":1,"limit_3h":5,"balance_1d":9,"used_1d":1,"limit_1d":10}', { status: 200 });
    },
  });
  const base = { name: '窗口中转', websiteUrl: '', usage: null, auth: {}, apiKey: 'shared-key' };

  await engine.query({ ...base, id: 'first', apiBaseUrl: 'https://first.example/v1' }, { balanceTemplateId: 'window-balance' });
  await engine.query({ ...base, id: 'second', apiBaseUrl: 'https://second.example/v1' }, { balanceTemplateId: 'window-balance' });

  assert.deepEqual(requests, [
    'https://first.example/v1/user/balance',
    'https://second.example/v1/user/balance',
  ]);
});
