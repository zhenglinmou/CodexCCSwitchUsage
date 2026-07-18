import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRepository } from '../src/provider-repository.mjs';

function providerRow(overrides = {}) {
  return {
    id: 'provider-1',
    name: 'Provider One',
    website_url: 'https://example.com',
    is_current: 1,
    sort_index: 2,
    settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'key' }, config: 'base_url="https://api.example.com"' }),
    meta: JSON.stringify({ usage_script: { enabled: true, code: '({})' } }),
    ...overrides,
  };
}

test('provider repository reuses its database, prepared statements and parsed rows', () => {
  let identity = 1;
  let row = providerRow();
  let opens = 0;
  let prepares = 0;
  const databases = [];
  const databaseFactory = () => {
    opens += 1;
    const database = {
      closed: false,
      prepare() {
        prepares += 1;
        return { get: () => row };
      },
      close() { this.closed = true; },
    };
    databases.push(database);
    return database;
  };
  const repository = new ProviderRepository('fake.db', {
    databaseFactory,
    statSync: () => ({ dev: 1, ino: identity, birthtimeMs: identity }),
  });

  const first = repository.getCurrent();
  const second = repository.getCurrent();
  assert.equal(first, second, 'unchanged raw database fields should reuse the parsed provider object');
  assert.equal(opens, 1);
  assert.equal(prepares, 1);

  row = providerRow({ name: 'Provider Renamed' });
  const changed = repository.getCurrent();
  assert.notEqual(changed, first);
  assert.equal(changed.name, 'Provider Renamed');
  assert.equal(opens, 1, 'normal database writes must keep the existing connection');

  identity = 2;
  repository.getCurrent();
  assert.equal(opens, 2, 'replacing the database file must reopen the connection');
  assert.equal(databases[0].closed, true);
  repository.close();
  assert.equal(databases[1].closed, true);
});

test('provider repository lists every Codex provider without exposing database writes', () => {
  const rows = [
    providerRow({ id: 'provider-2', name: 'Second', is_current: 0, sort_index: 2 }),
    providerRow({ id: 'provider-1', name: 'First', is_current: 1, sort_index: 1 }),
  ];
  let allCalls = 0;
  const repository = new ProviderRepository('fake.db', {
    databaseFactory: () => ({
      prepare(source) {
        assert.match(source, /WHERE app_type = 'codex'/);
        return {
          all() {
            allCalls += 1;
            return rows;
          },
        };
      },
      close() {},
    }),
    statSync: () => ({ dev: 1, ino: 1, birthtimeMs: 1 }),
  });

  const first = repository.getAll();
  const second = repository.getAll();

  assert.equal(first, second);
  assert.equal(allCalls, 2, 'read-only rows are rechecked so WAL updates are visible');
  assert.deepEqual(first.map(provider => ({ id: provider.id, current: provider.isCurrent })), [
    { id: 'provider-2', current: false },
    { id: 'provider-1', current: true },
  ]);
  assert.equal(first[0].auth.OPENAI_API_KEY, 'key');
  assert.equal(first[0].apiBaseUrl, 'https://api.example.com');
});

test('provider repository change token includes sqlite sidecar files', () => {
  const stats = new Map([
    ['test.db', { dev: 1, ino: 2, size: 10, mtimeMs: 100 }],
    ['test.db-wal', { dev: 1, ino: 3, size: 20, mtimeMs: 200 }],
  ]);
  const repository = new ProviderRepository('test.db', {
    statSync: filename => {
      if (!stats.has(filename)) throw new Error('missing');
      return stats.get(filename);
    },
  });

  const first = repository.getChangeToken();
  stats.set('test.db-wal', { dev: 1, ino: 3, size: 21, mtimeMs: 201 });
  const second = repository.getChangeToken();

  assert.notEqual(first, second);
  assert.match(first, /missing$/);
});

test('provider repository returns only safe fields for the latest provider requests', () => {
  let source = '';
  let boundValues = null;
  const repository = new ProviderRepository('fake.db', {
    databaseFactory: () => ({
      prepare(value) {
        source = value;
        return {
          all(...values) {
            boundValues = values;
            return [{
              request_id: 'must-not-leave-the-repository',
              session_id: 'must-not-leave-the-repository',
              error_message: 'Bearer private-token',
              model: 'gpt-5.6-sol',
              request_model: 'gpt-5.6-sol',
              input_tokens: 77_180,
              output_tokens: 1_200,
              cache_read_tokens: 73_344,
              cache_creation_tokens: 0,
              total_cost_usd: '0.091852',
              status_code: 200,
              created_at: 1_784_340_308,
            }];
          },
        };
      },
      close() {},
    }),
    statSync: () => ({ dev: 1, ino: 1, birthtimeMs: 1 }),
  });

  const rows = repository.getRecentRequests('provider-1', 500);

  assert.match(source, /WHERE app_type = 'codex' AND provider_id = \?/);
  assert.match(source, /ORDER BY created_at DESC, request_id DESC/);
  assert.deepEqual(boundValues, ['provider-1', 50], 'the repository must cap caller-controlled result sizes');
  assert.deepEqual(rows, [{
    model: 'gpt-5.6-sol',
    requestModel: 'gpt-5.6-sol',
    inputTokens: 77_180,
    outputTokens: 1_200,
    cacheReadTokens: 73_344,
    cacheCreationTokens: 0,
    totalCostUsd: 0.091852,
    statusCode: 200,
    createdAt: '2026-07-18T02:05:08.000Z',
  }]);
  assert.doesNotMatch(JSON.stringify(rows), /request_id|session_id|private-token/);
});
