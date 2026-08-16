import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProviderRow, ProviderRepository } from '../src/provider-repository.mjs';

test('provider rows bound public identifiers, URLs, and API keys', () => {
  const item = parseProviderRow({
    id: `provider\0${'x'.repeat(300)}`,
    name: `  Provider\n${'n'.repeat(300)}  `,
    website_url: `https://example.test/${'w'.repeat(3_000)}`,
    is_current: 1,
    settings_config: JSON.stringify({
      config: `base_url = "https://api.example.test/${'b'.repeat(3_000)}"`,
      auth: { OPENAI_API_KEY: 'k'.repeat(20_000) },
    }),
    meta: '{}',
  });

  assert.ok(item.id.length <= 160);
  assert.doesNotMatch(item.id, /\0/);
  assert.ok(item.name.length <= 160);
  assert.doesNotMatch(item.name, /[\r\n]/);
  assert.ok(item.websiteUrl.length <= 2_048);
  assert.ok(item.apiBaseUrl.length <= 2_048);
  assert.equal(item.apiKey.length, 16_384);
});

test('provider database scans cap rows and prefilter exact credential matches', () => {
  const prepared = [];
  const calls = [];
  const database = {
    prepare(sql) {
      prepared.push(sql);
      return {
        all(...args) { calls.push(args); return []; },
      };
    },
    close() {},
  };
  const repository = new ProviderRepository('test.db', {
    databaseFactory: () => database,
    statSync: () => ({ dev: 1, ino: 2, birthtimeMs: 3 }),
  });
  try {
    assert.deepEqual(repository.getAll(), []);
    assert.deepEqual(repository.getCredentialAppTypes('private-key'), []);
    assert.match(prepared[0], /LIMIT 513/);
    assert.match(prepared[0], /length\(settings_config\) <= 65536/);
    assert.equal((prepared[1].match(/instr\(settings_config, \?\) > 0/g) || []).length, 2);
    assert.match(prepared[1], /LIMIT 65/);
    assert.deepEqual(calls, [[], ['private-key', 'private-key']]);
  } finally {
    repository.close();
  }
});

test('provider database scans fail closed when row bounds overflow', () => {
  const database = {
    prepare(sql) {
      if (/WHERE app_type = 'codex'\s+ORDER BY/.test(sql)) {
        return { all: () => Array.from({ length: 513 }, () => ({})) };
      }
      return { all: () => Array.from({ length: 65 }, () => ({})) };
    },
    close() {},
  };
  const repository = new ProviderRepository('test.db', {
    databaseFactory: () => database,
    statSync: () => ({ dev: 1, ino: 2, birthtimeMs: 3 }),
  });
  try {
    assert.throws(() => repository.getAll(), /供应商数量超过安全上限 512/);
    assert.deepEqual(repository.getCredentialAppTypes('private-key'), ['unknown']);
  } finally {
    repository.close();
  }
});

test('recent request lookup lets SQLite choose the best available index', () => {
  const prepared = [];
  const calls = [];
  const database = {
    prepare(sql) {
      prepared.push(sql);
      return {
        all(providerId, limit) {
          calls.push([providerId, limit]);
          return [{
            model: 'gpt-5.6-sol',
            request_model: 'gpt-5.6-sol',
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 3,
            cache_creation_tokens: 0,
            total_cost_usd: '0.01',
            latency_ms: 1200,
            first_token_ms: 200,
            status_code: 200,
            created_at: 1_785_196_800,
          }];
        },
      };
    },
    close() {},
  };
  const repository = new ProviderRepository('test.db', {
    databaseFactory: () => database,
    statSync: () => ({ dev: 1, ino: 2, birthtimeMs: 3 }),
  });

  try {
    const rows = repository.getRecentRequests('provider-one', 500);
    assert.equal(prepared.length, 1);
    assert.doesNotMatch(prepared[0], /INDEXED\s+BY/i);
    assert.match(prepared[0], /ORDER BY created_at DESC, request_id DESC/);
    assert.deepEqual(calls, [['provider-one', 50]]);
    assert.equal(rows[0].statusCode, 200);
  } finally {
    repository.close();
  }
});
