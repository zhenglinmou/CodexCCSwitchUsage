import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageEvaluator } from '../src/evaluator.mjs';

test('one evaluator worker serves both request and extraction phases', async () => {
  const evaluator = createUsageEvaluator(`({
    request: { url: 'https://example.test/usage', method: 'GET' },
    extractor(response) { return { used: response.used, remaining: response.total - response.used }; }
  })`);

  try {
    assert.deepEqual(await evaluator.ready, { url: 'https://example.test/usage', method: 'GET' });
    assert.deepEqual(await evaluator.extract({ used: 2, total: 5 }), { used: 2, remaining: 3 });
  } finally {
    evaluator.close();
  }
});
