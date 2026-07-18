import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsage, readResponseTextLimited } from '../src/usage-client.mjs';

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

test('limited response reading rejects an oversized Content-Length before consuming the body', async () => {
  let textRead = false;
  const response = {
    headers: { get: name => name === 'content-length' ? '2000001' : null },
    async text() { textRead = true; return 'never'; },
  };

  await assert.rejects(readResponseTextLimited(response), /响应过大/);
  assert.equal(textRead, false);
});

test('limited response reading cancels a stream as soon as its byte budget is exceeded', async () => {
  const chunks = [new Uint8Array(600_000), new Uint8Array(600_000), new Uint8Array(600_000)];
  let reads = 0;
  let cancelled = false;
  let released = false;
  const response = {
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
          releaseLock() { released = true; },
        };
      },
    },
  };

  await assert.rejects(readResponseTextLimited(response, 1_000_000), /响应过大/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});
