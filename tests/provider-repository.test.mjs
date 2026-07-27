import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRepository } from '../src/provider-repository.mjs';

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
