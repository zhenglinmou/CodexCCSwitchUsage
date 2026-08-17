import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyProviderRequestLogApp,
  CodexSessionUsageReader,
  defaultRequestUsageTemplateId,
  describeProviderRequestUsage,
  isProviderRequestLogRow,
  normalizeRequestUsageLimit,
  parseProviderRequestLog,
  parseProviderRequestLogs,
  ProviderRequestUsageEngine,
} from '../src/provider-request-usage.mjs';

function writeJsonLines(filename, events) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function writeCodexAuth(codexHome, accountId, extraTokens = {}, observedAt = '2026-01-01T00:00:00.000Z') {
  const filename = path.join(codexHome, 'auth.json');
  fs.writeFileSync(filename, JSON.stringify({ tokens: { account_id: accountId, ...extraTokens } }), 'utf8');
  fs.utimesSync(filename, new Date(observedAt), new Date(observedAt));
  return filename;
}

test('OpenAI Official rejects an entire session file containing an oversized JSONL record', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-large-line-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'bounded-account');
  const filename = path.join(codexHome, 'sessions', 'oversized.jsonl');
  const events = [
    { timestamp: '2026-07-09T08:35:17.000Z', type: 'session_meta', payload: { id: 'bounded-session', model_provider: 'openai' } },
    { timestamp: '2026-07-09T08:35:19.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    {
      timestamp: '2026-07-09T08:36:16.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 13 },
          last_token_usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      },
    },
  ];
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${events.map(event => JSON.stringify(event)).join('\n')}\n${'x'.repeat(1_000_001)}\n`, 'utf8');

  const reader = new CodexSessionUsageReader({ codexHome });
  const result = await reader.query({ auth: { tokens: { account_id: 'bounded-account' } } });
  assert.deepEqual(result.items, []);
  assert.equal(result.totalRecords, 0);
  assert.equal(result.officialSessionCount, 0);
});

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

function accountLogPayload(rows, total = rows.length) {
  return {
    success: true,
    message: '',
    data: {
      page: 1,
      page_size: 100,
      total,
      items: rows,
    },
  };
}

test('OpenAI Official reads per-request Token usage from account-scoped Codex session events', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-session-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'official-account-one', { access_token: 'must-never-be-returned' });

  writeJsonLines(path.join(codexHome, 'sessions', '2026', '07', '09', 'official.jsonl'), [
    { timestamp: '2026-07-09T08:35:17.000Z', type: 'session_meta', payload: { id: 'official-session', model_provider: 'openai' } },
    { timestamp: '2026-07-09T08:35:18.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'private conversation text' } },
    { timestamp: '2026-07-09T08:35:19.000Z', type: 'turn_context', payload: { turn_id: 'turn-one', model: 'gpt-5.5' } },
    {
      timestamp: '2026-07-09T08:36:16.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
          last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
        },
        rate_limits: { plan_type: 'plus' },
      },
    },
    {
      timestamp: '2026-07-09T08:36:17.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
          last_token_usage: { input_tokens: 999, cached_input_tokens: 999, output_tokens: 999, reasoning_output_tokens: 999, total_tokens: 1998 },
        },
        rate_limits: { plan_type: 'plus' },
      },
    },
    {
      timestamp: '2026-07-09T08:37:04.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 25, cached_input_tokens: 14, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 33 },
          last_token_usage: { input_tokens: 15, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 20 },
        },
        rate_limits: { plan_type: 'plus' },
      },
    },
  ]);
  writeJsonLines(path.join(codexHome, 'sessions', '2026', '07', '10', 'custom.jsonl'), [
    { timestamp: '2026-07-10T00:00:00.000Z', type: 'session_meta', payload: { id: 'custom-session', model_provider: 'custom' } },
    { timestamp: '2026-07-10T00:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-custom', model: 'gpt-5.6-sol' } },
    {
      timestamp: '2026-07-10T00:00:02.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 9999, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 10000 },
          last_token_usage: { input_tokens: 9999, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 10000 },
        },
      },
    },
  ]);

  const provider = {
    id: 'openai-owned',
    name: 'OpenAI Official-我自己的',
    websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'official-account-one' } },
  };
  assert.equal(defaultRequestUsageTemplateId(provider), 'openai-codex-session');
  const description = describeProviderRequestUsage(provider);
  assert.equal(description.supported, true);
  assert.equal(description.adapter, 'openai-codex-session');
  assert.equal(description.method, 'LOCAL');

  const engine = new ProviderRequestUsageEngine({
    codexSessionUsageReader: new CodexSessionUsageReader({ codexHome }),
  });
  const result = await engine.query(provider, { limit: 10 });
  assert.equal(result.success, true);
  assert.equal(result.source, 'openai_codex_session');
  assert.equal(result.requestCount, 2);
  assert.equal(result.billing.available, false);
  assert.equal(result.billing.exact, false);
  assert.equal(result.billing.unit, 'subscription');
  assert.equal(result.officialIndexComplete, true);
  assert.deepEqual(result.items.map(item => ({
    createdAt: item.createdAt,
    model: item.model,
    inputTokens: item.inputTokens,
    cacheReadTokens: item.cacheReadTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    totalCost: item.totalCost,
    costExact: item.costExact,
  })), [
    {
      createdAt: '2026-07-09T08:37:04.000Z', model: 'gpt-5.5', inputTokens: 15,
      cacheReadTokens: 10, outputTokens: 5, totalTokens: 20, totalCost: null, costExact: false,
    },
    {
      createdAt: '2026-07-09T08:36:16.000Z', model: 'gpt-5.5', inputTokens: 10,
      cacheReadTokens: 4, outputTokens: 3, totalTokens: 13, totalCost: null, costExact: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private conversation text|must-never-be-returned|official-account-one/);

  const mismatched = await engine.query({
    ...provider,
    id: 'openai-other',
    name: 'OpenAI Official',
    auth: { tokens: { account_id: 'different-account' } },
  });
  assert.equal(mismatched.success, false);
  assert.equal(mismatched.errorType, 'account_scope');
  assert.match(mismatched.message, /当前 Codex 登录账号不匹配/);
});

test('OpenAI Official session index scans newest files first and stays bounded', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-index-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'indexed-account');
  const baseTime = Date.now() - 60_000;
  for (let index = 0; index < 8; index += 1) {
    const eventTime = baseTime - index * 60_000;
    const filename = path.join(codexHome, 'sessions', `session-${index}.jsonl`);
    writeJsonLines(filename, [
      { timestamp: new Date(eventTime - 1_000).toISOString(), type: 'session_meta', payload: { id: `session-${index}`, model_provider: 'openai' } },
      { timestamp: new Date(eventTime).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      {
        timestamp: new Date(eventTime).toISOString(), type: 'event_msg', payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: index + 1 },
            last_token_usage: { input_tokens: index + 1, output_tokens: 0, total_tokens: index + 1 },
          },
        },
      },
    ]);
    fs.utimesSync(filename, new Date(eventTime + 1_000), new Date(eventTime + 1_000));
  }
  const indexPath = path.join(codexHome, 'runtime', 'codex-session-index.json');
  const reader = new CodexSessionUsageReader({ codexHome, indexPath, maximumCachedFiles: 3 });
  const provider = {
    id: 'openai-indexed', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'indexed-account' } },
  };

  const result = await reader.query(provider, { limit: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id.startsWith('session-0:'), true);
  assert.equal(result.complete, false, 'older uncached files may be skipped once their mtime cannot enter the requested top-N');
  assert.equal(result.officialSessionCount, 4, 'the cold query should stop after a bounded newest-file safety window');
  assert.equal(reader.persistedIndex.size, 3);

  const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(persisted.files.length, 3);
  assert.ok(persisted.files.every(record => record.entry.result.items.length <= 64));
});

test('OpenAI Official session query selects newest files before applying the file limit', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-file-limit-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'file-limit-account');

  const sessions = [
    ['00-old', '2026-08-01T00:00:00.000Z'],
    ['01-old', '2026-08-02T00:00:00.000Z'],
    ['02-old', '2026-08-03T00:00:00.000Z'],
    ['98-new', '2026-08-04T00:00:00.000Z'],
    ['99-new', '2026-08-05T00:00:00.000Z'],
  ];
  for (const [id, timestamp] of sessions) {
    const filename = path.join(codexHome, 'sessions', `${id}.jsonl`);
    writeJsonLines(filename, [
      { timestamp, type: 'session_meta', payload: { id, model_provider: 'openai' } },
      { timestamp, type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      {
        timestamp, type: 'event_msg', payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 1 },
            last_token_usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        },
      },
    ]);
    const mtime = new Date(timestamp);
    fs.utimesSync(filename, mtime, mtime);
  }

  const reader = new CodexSessionUsageReader({ codexHome, maximumFiles: 3 });
  const result = await reader.query({
    id: 'openai-file-limit',
    name: 'OpenAI Official',
    websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'file-limit-account' } },
  }, { limit: 3 });

  assert.deepEqual(result.items.map(item => item.id.split(':', 1)[0]), ['99-new', '98-new', '02-old']);
  assert.equal(result.officialSessionCount, 3);
  assert.equal(result.complete, false, 'the bounded file list must report that older sessions were omitted');
});

test('OpenAI Official cold session scans stop at a total byte budget', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-byte-budget-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'byte-budget-account');
  const writeSession = (id, timestamp, padding) => {
    const filename = path.join(codexHome, 'sessions', `${id}.jsonl`);
    writeJsonLines(filename, [
      { timestamp, type: 'session_meta', payload: { id, model_provider: 'openai' } },
      { timestamp, type: 'turn_context', payload: { model: 'gpt-5.6-sol', padding } },
      { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1 }, last_token_usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } } },
    ]);
    fs.utimesSync(filename, new Date(timestamp), new Date(timestamp));
    return filename;
  };
  const newest = writeSession('newest', '2026-08-05T00:00:00.000Z', 'x'.repeat(2_000));
  writeSession('older', '2026-08-04T00:00:00.000Z', 'y'.repeat(2_000));
  const reader = new CodexSessionUsageReader({
    codexHome,
    maximumColdScanBytes: fs.statSync(newest).size + 64,
  });

  const result = await reader.query({
    id: 'openai-byte-budget', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'byte-budget-account' } },
  }, { limit: 10 });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id.startsWith('newest:'), true);
  assert.equal(result.complete, false);
  assert.equal(result.scanBudgetExceeded, true);

  const engine = new ProviderRequestUsageEngine({
    codexSessionUsageReader: {
      async query() {
        return { ...result, scanBudgetExceeded: true };
      },
    },
  });
  const engineResult = await engine.query({
    id: 'openai-byte-budget', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'byte-budget-account' } },
  }, { limit: 10 });
  assert.equal(engineResult.officialIndexComplete, false);
  assert.match(engineResult.message, /达到本地扫描上限/);
});

test('OpenAI Official session queries propagate caller cancellation before scanning', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-cancel-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'cancel-account');
  const controller = new AbortController();
  controller.abort(new Error('recent requests closed'));
  const reader = new CodexSessionUsageReader({ codexHome });

  await assert.rejects(reader.query({
    id: 'openai-cancel', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'cancel-account' } },
  }, { limit: 10, signal: controller.signal }), /recent requests closed/);

  let receivedSignal = null;
  const engine = new ProviderRequestUsageEngine({
    codexSessionUsageReader: {
      async query(_provider, options) {
        receivedSignal = options.signal;
        throw options.signal.reason;
      },
    },
  });
  await assert.rejects(engine.query({
    id: 'openai-cancel', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'cancel-account' } },
  }, { limit: 10, signal: controller.signal }), /recent requests closed/);
  assert.strictEqual(receivedSignal, controller.signal);
});

test('OpenAI Official session index resets at an account switch and excludes prior-account events', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-account-switch-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const indexPath = path.join(codexHome, 'runtime', 'codex-session-index.json');
  const writeSession = (id, timestamp) => {
    const filename = path.join(codexHome, 'sessions', `${id}.jsonl`);
    writeJsonLines(filename, [
      { timestamp, type: 'session_meta', payload: { id, model_provider: 'openai' } },
      { timestamp, type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      {
        timestamp, type: 'event_msg', payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 1 },
            last_token_usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        },
      },
    ]);
    fs.utimesSync(filename, new Date(timestamp), new Date(timestamp));
    return filename;
  };

  writeCodexAuth(codexHome, 'account-a', {}, '2026-07-01T00:00:00.000Z');
  const historicFilename = writeSession('historic-a', '2026-08-01T00:00:00.000Z');
  const reader = new CodexSessionUsageReader({ codexHome, indexPath });
  const providerA = { id: 'openai-a', name: 'OpenAI Official', auth: { tokens: { account_id: 'account-a' } } };
  assert.deepEqual((await reader.query(providerA, { limit: 10 })).items.map(item => item.id.split(':')[0]), ['historic-a']);

  writeCodexAuth(codexHome, 'account-b', {}, '2026-08-10T00:00:00.000Z');
  fs.utimesSync(historicFilename, new Date('2026-08-12T00:00:00.000Z'), new Date('2026-08-12T00:00:00.000Z'));
  writeSession('current-b', '2026-08-11T00:00:00.000Z');
  const providerB = { id: 'openai-b', name: 'OpenAI Official', auth: { tokens: { account_id: 'account-b' } } };
  const result = await reader.query(providerB, { limit: 10 });

  assert.deepEqual(result.items.map(item => item.id.split(':')[0]), ['current-b']);
  assert.equal(result.officialSessionCount, 1);
  const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(persisted.version, 3);
  assert.deepEqual(persisted.account, {
    id: 'account-b',
    boundaryMs: Date.parse('2026-08-10T00:00:00.000Z'),
  });
  assert.doesNotMatch(JSON.stringify(persisted), /historic-a/);
});

test('request usage status cache evicts old provider origins at its configured bound', async () => {
  const engine = new ProviderRequestUsageEngine({
    statusCacheMaximumEntries: 2,
    fetchImpl: async url => {
      const payload = String(url).endsWith('/api/status') ? statusPayload() : logPayload([]);
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });

  for (let index = 0; index < 3; index += 1) {
    await engine.query({
      id: `cache-provider-${index}`,
      name: `缓存供应商 ${index}`,
      apiBaseUrl: `https://cache-${index}.example/v1`,
      apiKey: `cache-key-${index}`,
    }, { requestUsageTemplateId: 'new-api-token-log' });
  }

  assert.equal(engine.statusCache.size, 2);
  assert.equal(engine.statusCache.has('https://cache-0.example'), false);
  assert.equal(engine.statusCache.has('https://cache-1.example'), true);
  assert.equal(engine.statusCache.has('https://cache-2.example'), true);
});

test('request usage engine creates the official session reader lazily', () => {
  const engine = new ProviderRequestUsageEngine({
    codexSessionUsageOptions: { indexPath: path.join(os.tmpdir(), 'unused-codex-index.json') },
  });

  assert.equal(engine.codexSessionUsageReader, null);
});

test('Codex session reader defers index loading until its first query', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-lazy-index-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'lazy-index-account');
  const filename = path.join(codexHome, 'sessions', 'active.jsonl');
  writeJsonLines(filename, [
    { timestamp: '2026-08-05T00:00:00.000Z', type: 'session_meta', payload: { id: 'active-session', model_provider: 'openai' } },
  ]);
  const stat = fs.statSync(filename);
  const indexPath = path.join(codexHome, 'runtime', 'codex-session-index.json');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({
    version: 3,
    account: { id: 'lazy-index-account', boundaryMs: Date.parse('2026-01-01T00:00:00.000Z') },
    files: [{
      filename,
      entry: {
        signature: `${stat.size}:${stat.mtimeMs}:${stat.birthtimeMs}`,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
        result: {
          official: true,
          scopeEligible: true,
          recordCount: 1,
          items: [{
            id: 'active-session:0:1',
            createdAt: '2026-08-05T00:00:00.000Z',
            model: 'gpt-5.6-sol',
            totalTokens: 1,
          }],
        },
        state: { sessionId: 'active-session', model: 'gpt-5.6-sol', previousCumulative: 1, segment: 0 },
      },
    }],
  }), 'utf8');

  const reader = new CodexSessionUsageReader({ codexHome, indexPath });
  assert.equal(reader.persistedIndex.size, 0);

  const result = await reader.query({
    id: 'openai-lazy-index',
    name: 'OpenAI Official',
    websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'lazy-index-account' } },
  }, { limit: 1 });

  assert.equal(reader.persistedIndex.size, 1);
  assert.equal(result.items[0].id, 'active-session:0:1');
});

test('Codex session index persistence awaits the cold snapshot and coalesces later writes', () => {
  const source = fs.readFileSync(new URL('../src/provider-request-usage.mjs', import.meta.url), 'utf8');

  assert.match(source, /await this\.\#persistInitialIndex\(\);/);
  assert.match(source, /this\.\#scheduleIndexWrite\(\);/);
  assert.match(source, /await secureAtomicWriteFile\(this\.indexPath/);
});

test('Codex session index flush persists one coalesced append snapshot', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-flush-index-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'flush-index-account');
  const filename = path.join(codexHome, 'sessions', 'active.jsonl');
  writeJsonLines(filename, [
    { timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'active', model_provider: 'openai' } },
    { timestamp: '2026-08-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1 }, last_token_usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } } },
  ]);
  const indexPath = path.join(codexHome, 'runtime', 'codex-session-index.json');
  const reader = new CodexSessionUsageReader({ codexHome, indexPath, indexWriteDelayMs: 60_000 });
  const provider = {
    id: 'openai-flush', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'flush-index-account' } },
  };

  await reader.query(provider, { limit: 10 });
  const firstPersisted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  fs.appendFileSync(filename, `${JSON.stringify({
    timestamp: '2026-08-01T00:00:02.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { total_tokens: 2 }, last_token_usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
    },
  })}\n`, 'utf8');
  const live = await reader.query(provider, { limit: 10 });
  const beforeFlush = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  assert.equal(live.totalRecords, 2);
  assert.deepEqual(beforeFlush, firstPersisted);
  await reader.close();
  const afterFlush = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(afterFlush.files[0].entry.result.recordCount, 2);
});

test('OpenAI Official session index parses only appended JSONL records', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-append-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'append-account');
  const filename = path.join(codexHome, 'sessions', 'active.jsonl');
  writeJsonLines(filename, [
    { timestamp: '2026-07-29T01:00:00.000Z', type: 'session_meta', payload: { id: 'active-session', model_provider: 'openai' } },
    { timestamp: '2026-07-29T01:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    {
      timestamp: '2026-07-29T01:00:02.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 10 },
          last_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        },
      },
    },
  ]);
  const reader = new CodexSessionUsageReader({
    codexHome,
    indexPath: path.join(codexHome, 'runtime', 'codex-session-index.json'),
  });
  const provider = {
    id: 'openai-append', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'append-account' } },
  };

  const first = await reader.query(provider, { limit: 10 });
  assert.equal(first.totalRecords, 1);
  fs.appendFileSync(filename, `${JSON.stringify({
    timestamp: '2026-07-29T01:00:03.000Z', type: 'event_msg', payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: 30 },
        last_token_usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      },
    },
  })}\n`, 'utf8');

  const second = await reader.query(provider, { limit: 10 });
  assert.equal(second.totalRecords, 2);
  assert.deepEqual(second.items.map(item => item.totalTokens), [20, 10]);
  assert.equal(second.items[0].model, 'gpt-5.6-sol', 'incremental parsing retains prior session state');
});

test('OpenAI Official session index rejects a rewritten append boundary', async t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-official-rewrite-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeCodexAuth(codexHome, 'rewrite-account');
  const filename = path.join(codexHome, 'sessions', 'active.jsonl');
  writeJsonLines(filename, [
    { timestamp: '2026-07-29T01:00:00.000Z', type: 'session_meta', payload: { id: 'old-session', model_provider: 'openai' } },
    {
      timestamp: '2026-07-29T01:00:01.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 10 },
          last_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        },
      },
    },
  ]);
  const originalSize = fs.statSync(filename).size;
  const reader = new CodexSessionUsageReader({
    codexHome,
    indexPath: path.join(codexHome, 'runtime', 'codex-session-index.json'),
  });
  const provider = {
    id: 'openai-rewrite', name: 'OpenAI Official', websiteUrl: 'https://chatgpt.com/codex',
    auth: { tokens: { account_id: 'rewrite-account' } },
  };
  assert.equal((await reader.query(provider, { limit: 10 })).items[0].id.startsWith('old-session:'), true);

  writeJsonLines(filename, [
    { timestamp: '2026-07-29T02:00:00.000Z', type: 'session_meta', payload: { id: 'new-session', model_provider: 'openai' } },
    { timestamp: '2026-07-29T02:00:01.000Z', type: 'turn_context', payload: { model: `gpt-5.6-sol-${'x'.repeat(originalSize)}` } },
    {
      timestamp: '2026-07-29T02:00:02.000Z', type: 'event_msg', payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 99 },
          last_token_usage: { input_tokens: 90, output_tokens: 9, total_tokens: 99 },
        },
      },
    },
  ]);
  assert.ok(fs.statSync(filename).size > originalSize, 'the rewritten file must still look like a possible append by size');

  const result = await reader.query(provider, { limit: 10 });
  assert.equal(result.totalRecords, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id.startsWith('new-session:'), true);
  assert.equal(result.items[0].totalTokens, 99);
});

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

test('request-usage auto-detection rejects New API arrays without a request activity row', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([
          { id: 3, created_at: 30, type: 1, content: 'top up' },
          { id: 2, created_at: 20, type: 3, content: 'manage token' },
          { id: 1, created_at: 10, type: 4, content: 'system event' },
        ])), { status: 200 }),
  });
  const result = await engine.query({
    id: 'non-consumption-lookalike',
    name: '只有账户事件的伪逐请求接口',
    apiBaseUrl: 'https://lookalike.example/v1',
    apiKey: 'private-key',
  }, { requestUsageTemplateId: 'new-api-token-log' });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'schema');
  assert.match(result.message, /请求日志/);
});

test('request-usage auto-detection rejects content-only type-2 lookalikes', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? { success: true, data: {} }
      : logPayload([{ id: 1, created_at: 10, type: 2, content: 'looks like a request' }])), { status: 200 }),
  });
  const result = await engine.query({
    id: 'content-only-lookalike',
    name: '内容字段伪装的逐请求接口',
    apiBaseUrl: 'https://lookalike.example/v1',
    apiKey: 'private-key',
  }, { requestUsageTemplateId: 'new-api-token-log' });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'schema');
  assert.match(result.message, /请求日志/);
});

test('request-usage auto-detection rejects request-type rows whose evidence fields are only empty placeholders', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([
          {
            id: 2, created_at: 20, type: 2, content: '', model_name: '', quota: null,
            prompt_tokens: null, completion_tokens: null, use_time: null, token_name: '', channel_name: '', other: '',
          },
          {
            id: 1, created_at: 10, type: 5, content: '', model_name: '', quota: null,
            prompt_tokens: null, completion_tokens: null, use_time: null, token_name: '', channel_name: '', other: '{}',
          },
        ])), { status: 200 }),
  });
  const result = await engine.query({
    id: 'empty-placeholder-lookalike',
    name: '空占位字段伪逐请求接口',
    apiBaseUrl: 'https://lookalike.example/v1',
    apiKey: 'private-key',
  }, { requestUsageTemplateId: 'new-api-token-log' });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'schema');
  assert.match(result.message, /请求日志/);
});

test('request-usage accepts error-only request logs with zero tokens and cost', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([
          {
            id: 2, created_at: 20, type: 5, model_name: 'gpt-5.6-sol', quota: 0,
            prompt_tokens: 0, completion_tokens: 0,
            other: JSON.stringify({ status_code: 503, request_path: '/v1/responses' }),
          },
          {
            id: 1, created_at: 10, type: 5, model_name: 'gpt-5.6-sol', quota: 0,
            prompt_tokens: 0, completion_tokens: 0,
            other: JSON.stringify({ status_code: 503, request_path: '/v1/responses' }),
          },
        ])), { status: 200 }),
  });

  const result = await engine.query({
    id: 'error-only-new-api',
    name: '只有失败请求的 New API 站',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'private-key',
  }, { requestUsageTemplateId: 'new-api-token-log', appType: 'codex', strictAppType: true });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_log');
  assert.equal(result.requestCount, 2);
  assert.equal(result.items.every(item => item.recordType === 'error' && item.statusCode === 503), true);
  assert.equal(result.items.every(item => item.totalTokens === 0 && item.totalCost === 0), true);
});

test('empty Token logs auto-detect safely correlated browser account logs on any New API origin', async () => {
  const browserCalls = [];
  let localReads = 0;
  const engine = new ProviderRequestUsageEngine({
    now: () => 1_700_000_100_000,
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([])), { status: 200 }),
    browserBroker: {
      isConnected: () => true,
      listQueryClients(origin) {
        assert.equal(origin, 'https://relay.example');
        return [{ clientRef: 'edge-account-one', browser: 'Edge', hasSession: true }];
      },
      async queryJsonOnClient(clientRef, request) {
        browserCalls.push({ clientRef, request });
        return {
          status: 200,
          text: JSON.stringify(accountLogPayload([
            {
              id: 14, created_at: 1_700_000_099, type: 2, token_name: 'current-key', model_name: 'gpt-5.6-sol',
              quota: 90_000, prompt_tokens: 9_000, completion_tokens: 90,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
            {
              id: 13, created_at: 1_700_000_098, type: 2, token_name: 'current-key', model_name: 'claude-sonnet-4',
              quota: 80_000, prompt_tokens: 800, completion_tokens: 80,
              other: JSON.stringify({ request_path: '/v1/messages' }),
            },
            {
              id: 12, created_at: 1_700_000_097, type: 2, token_name: 'current-key', model_name: 'gpt-5.6-sol',
              quota: 50_000, prompt_tokens: 5_000, completion_tokens: 50,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
            {
              id: 11, created_at: 1_700_000_090, type: 2, token_name: 'current-key', model_name: 'gpt-5.6-sol',
              quota: 40_000, prompt_tokens: 4_000, completion_tokens: 40,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
          ], 4)),
        };
      },
    },
  });

  const result = await engine.query({
    id: 'future-new-api',
    name: '未来 New API 站',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'relay-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    appType: 'codex',
    strictAppType: true,
    getLocalRequestRows() {
      localReads += 1;
      return [
        {
          createdAt: '2023-11-14T22:14:57.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
          inputTokens: 5_000, outputTokens: 50, statusCode: 200,
        },
        {
          createdAt: '2023-11-14T22:14:50.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
          inputTokens: 4_000, outputTokens: 40, statusCode: 200,
        },
      ];
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_account_log');
  assert.equal(result.accountLogAutoDetected, true);
  assert.equal(result.keyAssociation, 'local-correlation');
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.items.map(item => item.id), ['12', '11']);
  assert.equal(localReads, 1);
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0].clientRef, 'edge-account-one');
  assert.equal(browserCalls[0].request.userHeader, 'New-Api-User');
  assert.equal(browserCalls[0].request.headers.Authorization, undefined);
  assert.match(browserCalls[0].request.requestPath, /^\/api\/log\/self\/\?/);
  assert.match(browserCalls[0].request.requestPath, /page_size=100/);
});

test('account-log correlation accepts provider completion counts that exclude reasoning output', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([])), { status: 200 }),
    browserBroker: {
      isConnected: () => true,
      listQueryClients: () => [{ clientRef: 'edge-anyrouter', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        return {
          status: 200,
          text: JSON.stringify(accountLogPayload([
            {
              id: 52, token_id: 7, token_name: 'current-key', created_at: 1_700_000_099, type: 2,
              model_name: 'gpt-5.6-sol', quota: 90_000, prompt_tokens: 31_082, completion_tokens: 46,
              other: JSON.stringify({ request_path: '/v1/responses', cache_tokens: 30_208 }),
            },
            {
              id: 51, token_id: 7, token_name: 'current-key', created_at: 1_700_000_090, type: 2,
              model_name: 'gpt-5.6-sol', quota: 80_000, prompt_tokens: 30_845, completion_tokens: 40,
              other: JSON.stringify({ request_path: '/v1/responses', cache_tokens: 30_208 }),
            },
          ])),
        };
      },
    },
  });

  const result = await engine.query({
    id: 'anyrouter-reasoning',
    name: 'AnyRouter',
    apiBaseUrl: 'https://anyrouter.top/v1',
    apiKey: 'anyrouter-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    appType: 'codex',
    getLocalRequestRows: () => [
      {
        createdAt: '2023-11-14T22:14:59.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 31_082, outputTokens: 264, statusCode: 200,
      },
      {
        createdAt: '2023-11-14T22:14:50.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 30_845, outputTokens: 40, statusCode: 200,
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_account_log');
  assert.equal(result.localCorrelationMatches, 2);
  assert.deepEqual(result.items.map(item => item.id), ['52', '51']);
});

test('non-AnyRouter account-log correlation keeps exact completion token matching', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([])), { status: 200 }),
    browserBroker: {
      isConnected: () => true,
      listQueryClients: () => [{ clientRef: 'edge-relay', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        return {
          status: 200,
          text: JSON.stringify(accountLogPayload([
            {
              id: 62, token_id: 9, token_name: 'relay-key', created_at: 1_700_000_099, type: 2,
              model_name: 'gpt-5.6-sol', quota: 90_000, prompt_tokens: 31_082, completion_tokens: 46,
              other: JSON.stringify({ request_path: '/v1/responses', cache_tokens: 30_208 }),
            },
            {
              id: 61, token_id: 9, token_name: 'relay-key', created_at: 1_700_000_090, type: 2,
              model_name: 'gpt-5.6-sol', quota: 80_000, prompt_tokens: 30_845, completion_tokens: 40,
              other: JSON.stringify({ request_path: '/v1/responses', cache_tokens: 30_208 }),
            },
          ])),
        };
      },
    },
  });

  const result = await engine.query({
    id: 'ordinary-relay',
    name: '普通 New API 中转',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'relay-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    appType: 'codex',
    getLocalRequestRows: () => [
      {
        createdAt: '2023-11-14T22:14:59.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 31_082, outputTokens: 264, statusCode: 200,
      },
      {
        createdAt: '2023-11-14T22:14:50.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 30_845, outputTokens: 40, statusCode: 200,
      },
    ],
  });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'account_scope');
});

test('Token-log WAF failures use the same safely correlated browser account-log fallback', async () => {
  let tokenBrowserCalls = 0;
  let accountBrowserCalls = 0;
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => {
      if (String(url).endsWith('/api/status')) {
        return new Response(JSON.stringify(statusPayload()), { status: 200 });
      }
      return new Response('<html>challenge</html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      });
    },
    browserBroker: {
      isConnected: () => true,
      async queryJson() {
        tokenBrowserCalls += 1;
        return { status: 403, text: '<html>challenge</html>' };
      },
      listQueryClients: () => [{ clientRef: 'edge-account-one', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        accountBrowserCalls += 1;
        return {
          status: 200,
          text: JSON.stringify(accountLogPayload([
            {
              id: 32, token_id: 7, created_at: 1_700_000_097, type: 2, token_name: 'current-key',
              model_name: 'gpt-5.6-sol', quota: 50_000, prompt_tokens: 5_000, completion_tokens: 50,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
            {
              id: 31, token_id: 7, created_at: 1_700_000_090, type: 2, token_name: 'current-key',
              model_name: 'gpt-5.6-sol', quota: 40_000, prompt_tokens: 4_000, completion_tokens: 40,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
          ])),
        };
      },
    },
  });

  const result = await engine.query({
    id: 'waf-new-api',
    name: 'WAF New API 站',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'relay-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    appType: 'codex',
    strictAppType: true,
    getLocalRequestRows: () => [
      {
        createdAt: '2023-11-14T22:14:57.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 5_000, outputTokens: 50, statusCode: 200,
      },
      {
        createdAt: '2023-11-14T22:14:50.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 4_000, outputTokens: 40, statusCode: 200,
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_account_log');
  assert.equal(result.correlationIdentity, 'token-id');
  assert.equal(result.requestCount, 2);
  assert.equal(tokenBrowserCalls, 1);
  assert.equal(accountBrowserCalls, 1);
});

test('correlated account logs remain usable when the billing status endpoint is also WAF-blocked', async () => {
  let accountBrowserCalls = 0;
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response('<html>challenge</html>', {
      status: String(url).endsWith('/api/status') ? 200 : 403,
      headers: { 'content-type': 'text/html' },
    }),
    browserBroker: {
      isConnected: () => true,
      async queryJson() {
        return { status: 403, text: '<html>challenge</html>' };
      },
      listQueryClients: () => [{ clientRef: 'edge-account-one', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        accountBrowserCalls += 1;
        return {
          status: 200,
          text: JSON.stringify(accountLogPayload([
            {
              id: 42, token_id: 7, created_at: 1_700_000_097, type: 2, token_name: 'current-key',
              model_name: 'gpt-5.6-sol', quota: 50_000, prompt_tokens: 5_000, completion_tokens: 50,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
            {
              id: 41, token_id: 7, created_at: 1_700_000_090, type: 2, token_name: 'current-key',
              model_name: 'gpt-5.6-sol', quota: 40_000, prompt_tokens: 4_000, completion_tokens: 40,
              other: JSON.stringify({ request_path: '/v1/responses' }),
            },
          ])),
        };
      },
    },
  });

  const result = await engine.query({
    id: 'fully-waf-blocked',
    name: '完全受 WAF 保护的 New API 站',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'relay-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    appType: 'codex',
    strictAppType: true,
    getLocalRequestRows: () => [
      {
        createdAt: '2023-11-14T22:14:57.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 5_000, outputTokens: 50, statusCode: 200,
      },
      {
        createdAt: '2023-11-14T22:14:50.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
        inputTokens: 4_000, outputTokens: 40, statusCode: 200,
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.source, 'provider_account_log');
  assert.equal(result.billing.available, false);
  assert.equal(result.degraded, true);
  assert.equal(result.requestCount, 2);
  assert.equal(result.items.every(item => item.costExact === false), true);
  assert.equal(accountBrowserCalls, 1);
});

test('account-log auto-detection refuses rows that cannot be attributed to the current provider Key', async () => {
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : logPayload([])), { status: 200 }),
    browserBroker: {
      isConnected: () => true,
      listQueryClients: () => [{ clientRef: 'edge-account-one', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        return {
          status: 200,
          text: JSON.stringify(accountLogPayload([
            {
              id: 21, created_at: 1_700_000_000, type: 2, token_name: 'another-key', model_name: 'gpt-5.6-sol',
              quota: 5_000, prompt_tokens: 500, completion_tokens: 5,
            },
          ])),
        };
      },
    },
  });

  const result = await engine.query({
    id: 'future-new-api',
    name: '未来 New API 站',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'relay-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    getLocalRequestRows: () => [{
      createdAt: '2023-11-14T22:13:20.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
      inputTokens: 999, outputTokens: 9, statusCode: 200,
    }],
  });

  assert.equal(result.success, false);
  assert.equal(result.errorType, 'account_scope');
  assert.match(result.message, /无法归属到当前供应商 API Key/);
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

test('request-usage authentication failures never fall through to browser account logs', async () => {
  let browserCalls = 0;
  const engine = new ProviderRequestUsageEngine({
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith('/api/status')
      ? statusPayload()
      : { success: false, message: 'invalid API key' }), {
      status: String(url).endsWith('/api/status') ? 200 : 401,
    }),
    browserBroker: {
      isConnected: () => true,
      async queryJson() {
        browserCalls += 1;
        throw new Error('401 must not enter browser fallback');
      },
      listQueryClients: () => [{ clientRef: 'edge-account-one', browser: 'Edge', hasSession: true }],
      async queryJsonOnClient() {
        browserCalls += 1;
        throw new Error('401 must not enter account-log fallback');
      },
    },
  });

  const result = await engine.query({
    id: 'invalid-key',
    name: '鉴权失败的 New API 站',
    apiBaseUrl: 'https://relay.example/v1',
    apiKey: 'invalid-private-key',
  }, {
    requestUsageTemplateId: 'new-api-token-log',
    getLocalRequestRows: () => [{
      createdAt: '2023-11-14T22:13:20.000Z', model: 'gpt-5.6-sol', requestModel: 'gpt-5.6-sol',
      inputTokens: 999, outputTokens: 9, statusCode: 200,
    }],
  });

  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.errorType, 'authentication');
  assert.equal(browserCalls, 0);
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
