import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isTrustedHttpUrl, resetHttpAllowlistCache } from '../src/http-allowlist.mjs';
import {
  describeProviderQuery,
  ProviderQueryEngine,
} from '../src/hub-provider-adapters.mjs';
import { describeProviderRequestUsage, ProviderRequestUsageEngine } from '../src/provider-request-usage.mjs';
import { normalizeProviderTemplateOrigin } from '../src/provider-templates.mjs';

test('remote HTTP opt-in is pinned to one provider id and exact origin', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-http-allowlist-'));
  const filename = path.join(directory, 'allow-http-origins.json');
  const previousFilename = process.env.CCSWITCH_HTTP_ALLOWLIST_FILE;
  fs.writeFileSync(filename, JSON.stringify({
    providers: {
      'company-provider': ['http://company.example.test:28080/v1'],
    },
  }));
  process.env.CCSWITCH_HTTP_ALLOWLIST_FILE = filename;
  resetHttpAllowlistCache();
  t.after(() => {
    if (previousFilename == null) delete process.env.CCSWITCH_HTTP_ALLOWLIST_FILE;
    else process.env.CCSWITCH_HTTP_ALLOWLIST_FILE = previousFilename;
    resetHttpAllowlistCache();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const provider = {
    id: 'company-provider',
    name: 'Company New API',
    websiteUrl: '',
    usage: null,
    auth: {},
    apiKey: 'private-key',
    apiBaseUrl: 'http://company.example.test:28080/v1',
    baseUrl: 'http://company.example.test:28080/v1',
  };
  assert.equal(isTrustedHttpUrl(provider.apiBaseUrl, provider), true);
  assert.equal(isTrustedHttpUrl('http://company.example.test:28081/v1', provider), false);
  assert.equal(isTrustedHttpUrl(provider.apiBaseUrl, { ...provider, id: 'other-provider' }), false);
  assert.equal(isTrustedHttpUrl('http://127.0.0.1:8317/v1', { id: 'other-provider' }), true);
  assert.equal(normalizeProviderTemplateOrigin(provider), 'http://company.example.test:28080');
  assert.equal(normalizeProviderTemplateOrigin({ ...provider, id: 'other-provider' }), '');

  const balanceDescription = describeProviderQuery(provider, 'new-api-key-quota');
  assert.equal(balanceDescription.requestUrl, 'http://company.example.test:28080/api/usage/token/');
  assert.equal(balanceDescription.waf, false);
  assert.equal(balanceDescription.requiresBrowser, false);
  assert.match(balanceDescription.executor, /不进入浏览器伴侣/);

  const requestDescription = describeProviderRequestUsage(provider, 'new-api-token-log');
  assert.equal(requestDescription.supported, true);
  assert.equal(requestDescription.requestUrl, 'http://company.example.test:28080/api/log/token');
  assert.equal(requestDescription.requiresBrowser, false);

  let requestBrowserCalls = 0;
  const requestEngine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? { success: true, data: { quota_display_type: 'USD', quota_per_unit: 500_000 } }
      : { success: true, data: [] }), { status: 200 }),
    browserBroker: {
      isConnected: () => true,
      listQueryClients: () => [{ clientRef: 'edge-http', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        requestBrowserCalls += 1;
        throw new Error('HTTP opt-in must not use browser account sessions');
      },
    },
  });
  const requestResult = await requestEngine.query(provider, {
    requestUsageTemplateId: 'new-api-token-log',
    getLocalRequestRows: () => [
      {
        createdAt: '2026-07-28T01:00:00.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 100, outputTokens: 10, statusCode: 200,
      },
      {
        createdAt: '2026-07-28T00:59:00.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 90, outputTokens: 9, statusCode: 200,
      },
    ],
  });
  assert.equal(requestResult.success, false);
  assert.equal(requestResult.errorType, 'account_scope');
  assert.equal(requestBrowserCalls, 0);

  const calls = [];
  const engine = new ProviderQueryEngine({}, {
    isConnected: () => true,
    queryJson: async () => { throw new Error('HTTP opt-in must not use the browser companion'); },
  }, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.Authorization || '' });
      if (String(url).endsWith('/api/status')) {
        return new Response(JSON.stringify({
          success: true,
          data: { quota_display_type: 'USD', quota_per_unit: 500_000 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: true,
        data: {
          unlimited_quota: false,
          total_available: 500_000,
          total_used: 250_000,
          total_granted: 750_000,
        },
      }), { status: 200 });
    },
  });
  const result = await engine.query(provider, { balanceTemplateId: 'new-api-key-quota' });
  assert.equal(result.usage.remaining, 1);
  assert.equal(result.usage.used, 0.5);
  assert.equal(result.usage.total, 1.5);
  assert.deepEqual(calls, [
    { url: 'http://company.example.test:28080/api/usage/token/', authorization: 'Bearer private-key' },
    { url: 'http://company.example.test:28080/api/status', authorization: '' },
  ]);

  await assert.rejects(engine.query({ ...provider, id: 'other-provider' }, {
    balanceTemplateId: 'new-api-key-quota',
  }), /非本地供应商接口必须使用 HTTPS/);
  await assert.rejects(engine.query({
    ...provider,
    apiBaseUrl: 'http://company.example.test:28081/v1',
    baseUrl: 'http://company.example.test:28081/v1',
  }, { balanceTemplateId: 'new-api-key-quota' }), /非本地供应商接口必须使用 HTTPS/);
});
