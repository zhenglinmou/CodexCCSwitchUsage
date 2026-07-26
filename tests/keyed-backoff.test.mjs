import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RETRY_DELAYS_MS, KeyedBackoff } from '../src/keyed-backoff.mjs';

test('keyed backoff retries with a bounded sequence and resets on success', () => {
  let now = 1_000;
  const backoff = new KeyedBackoff({ now: () => now });

  assert.equal(backoff.isReady('main'), true);
  for (const delay of DEFAULT_RETRY_DELAYS_MS) {
    assert.equal(backoff.fail('main'), delay);
    assert.equal(backoff.isReady('main'), false);
    assert.equal(backoff.remainingMs(), delay);
    now += delay;
    assert.equal(backoff.isReady('main'), true);
  }

  assert.equal(backoff.fail('main'), DEFAULT_RETRY_DELAYS_MS.at(-1));
  assert.equal(backoff.isReady('replacement-main'), true, 'a replacement target must bypass an old target failure');
  backoff.reset();
  assert.equal(backoff.failures, 0);
  assert.equal(backoff.remainingMs(), 0);
  assert.equal(backoff.isReady('main'), true);
});

test('a failure on a replacement target restarts the retry sequence', () => {
  let now = 0;
  const backoff = new KeyedBackoff({ delays: [10, 20], now: () => now });

  assert.equal(backoff.fail('old'), 10);
  now += 10;
  assert.equal(backoff.fail('old'), 20);
  assert.equal(backoff.fail('new'), 10);
  assert.equal(backoff.failures, 1);
});
