import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsage } from '../src/usage-client.mjs';

test('usage normalization preserves unavailable numeric fields as null', () => {
  const provider = { id: 'one', name: 'Provider', websiteUrl: '', usage: { autoQueryInterval: 5 } };
  const result = normalizeUsage(provider, {
    planName: 'Plan',
    remaining: 12.5,
    used: null,
    total: undefined,
    unit: 'CNY',
  });

  assert.equal(result.remaining, 12.5);
  assert.equal(result.used, null);
  assert.equal(result.total, null);
});
