import assert from 'node:assert/strict';
import test from 'node:test';
import { describeProviderQuery, fetchJson, loginConfiguration, parseBrowserJson, ProviderQueryEngine, providerAliases, providerKind, summarizeWham } from '../src/hub-provider-adapters.mjs';

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

test('provider query descriptions expose the real request shape without credentials', () => {
  const browserMethod = describeProviderQuery({
    name: 'agentrouter',
    apiBaseUrl: 'https://user:password@api.agent.example/v1/?access_token=private',
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
  assert.equal(apiMethod.authentication, 'Bearer API Key');
  assert.equal(apiMethod.requiresBrowser, false);
  assert.doesNotMatch(JSON.stringify(apiMethod), /another-private-key/);
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
    apiKey: 'model-key', apiBaseUrl: 'https://api.agent.example', baseUrl: 'http://127.0.0.1:17891',
  });

  assert.equal(result.loginRequired, false);
  assert.equal(result.source, 'browser_session');
  assert.match(result.message, /伴侣扩展未连接/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(calls.join(' '), /17891/);
});

test('provider API keys are never sent to remote HTTP endpoints', async () => {
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

  const result = await engine.openLogin({ id: 'any', name: 'any的国外我自己的' });

  assert.equal(received.userHeader, 'New-Api-User');
  assert.equal(result.synced, true);
  assert.equal(result.opened, false);
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

  assert.equal(result.loginRequired, true);
  assert.equal(result.usage, undefined);
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
  assert.equal(first.usage.providerName, '付费站');
  assert.equal(second.usage.providerId, 'copy');
  assert.equal(second.usage.providerName, '付费站 copy');
});
