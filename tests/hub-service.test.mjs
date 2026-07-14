import assert from 'node:assert/strict';
import test from 'node:test';
import { HubService } from '../src/hub-service.mjs';

function provider(id, name, current = false) {
  return { id, name, websiteUrl: 'https://example.com', isCurrent: current, usage: null, auth: {}, apiKey: '', baseUrl: '' };
}

test('Hub state exposes safe provider fields and refreshes with bounded concurrency', async () => {
  const providers = [provider('one', 'DeepSeek', true), provider('two', 'PackyCode'), provider('three', '付费站')];
  let running = 0;
  let maximum = 0;
  const repository = { getAll: () => providers };
  const queryEngine = {
    async query(item) {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 1, remaining: 9, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-14T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  };
  const service = new HubService(repository, queryEngine, { concurrency: 2 });

  await service.refreshAll();
  const state = service.getState();

  assert.equal(maximum, 2);
  assert.equal(state.providers.length, 3);
  assert.equal(state.providers[0].current, true);
  assert.equal(state.providers[0].status, 'ok');
  assert.equal(state.providers[0].usage.remaining, 9);
  assert.equal('auth' in state.providers[0], false);
  assert.equal('apiKey' in state.providers[0], false);
});

test('Hub errors redact bearer tokens and preserve the last successful usage', async () => {
  const item = provider('one', 'AgentRouter');
  let fail = false;
  const service = new HubService({ getAll: () => [item] }, {
    async query() {
      if (fail) throw new Error('Authorization: Bearer secret-value');
      return {
        source: 'test',
        usage: {
          status: 'ok', providerId: item.id, providerName: item.name, used: 2, remaining: 8, total: 10,
          unit: 'USD', extra: '', updatedAt: '2026-07-14T00:00:00.000Z', refreshIntervalMinutes: 5,
        },
      };
    },
  });

  await service.refreshProvider(item.id);
  fail = true;
  await service.refreshProvider(item.id);
  const state = service.getState().providers[0];

  assert.equal(state.status, 'error');
  assert.equal(state.usage.remaining, 8);
  assert.doesNotMatch(state.message, /secret-value/);
  assert.match(state.message, /\[redacted\]/);
});
