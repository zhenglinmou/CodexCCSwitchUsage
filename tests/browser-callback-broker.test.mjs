import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCallbackBroker } from '../src/browser-callback-broker.mjs';

test('browser callback broker delivers a query and resolves its callback', async () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat({ clientId: 'edge-client-one', browser: 'Edge', version: '1', sessions: ['https://anyrouter.top'] });
  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  const job = await broker.nextJob({ clientId: 'edge-client-one', browser: 'Edge' }, 1_000);

  assert.equal(job.type, 'query-json');
  assert.equal(job.request.origin, 'https://anyrouter.top');
  assert.equal(broker.complete(job.id, { ok: true, value: { status: 200, text: '{"success":true}' } }), true);
  assert.deepEqual(await resultPromise, { status: 200, text: '{"success":true}' });
  broker.close();
});

test('browser callback broker never queues credentials without an active companion', async () => {
  const broker = new BrowserCallbackBroker();
  await assert.rejects(
    broker.queryJson({ baseUrl: 'https://chatgpt.com', headers: { Authorization: 'Bearer private' } }),
    /未连接/,
  );
  assert.equal(broker.getStatus().queuedJobs, 0);
});

test('browser callback broker cancels an obsolete queued query immediately', async () => {
  const broker = new BrowserCallbackBroker();
  const controller = new AbortController();
  broker.heartbeat({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://chatgpt.com'] });
  const resultPromise = broker.queryJson({ baseUrl: 'https://chatgpt.com', requestPath: '/backend-api/wham/usage' }, { signal: controller.signal });

  assert.equal(broker.getStatus().queuedJobs, 1);
  assert.equal(broker.getStatus().pendingJobs, 1);
  controller.abort(new Error('direct transport won'));

  await assert.rejects(resultPromise, /direct transport won/);
  assert.equal(broker.getStatus().queuedJobs, 0);
  assert.equal(broker.getStatus().pendingJobs, 0);
  broker.close();
});

test('browser callback broker releases an obsolete query after a companion has claimed it', async () => {
  const broker = new BrowserCallbackBroker();
  const controller = new AbortController();
  broker.heartbeat({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://chatgpt.com'] });
  const jobPromise = broker.nextJob({ clientId: 'edge-client-one', browser: 'Edge' }, 1_000);
  const resultPromise = broker.queryJson({ baseUrl: 'https://chatgpt.com', requestPath: '/backend-api/wham/usage' }, { signal: controller.signal });
  const job = await jobPromise;

  assert.equal(broker.getStatus().queuedJobs, 0);
  assert.equal(broker.getStatus().pendingJobs, 1);
  controller.abort(new Error('direct transport won'));

  await assert.rejects(resultPromise, /direct transport won/);
  assert.equal(broker.getStatus().pendingJobs, 0);
  assert.equal(broker.complete(job.id, { ok: true, value: { status: 200, text: '{}' } }), false);
  broker.close();
});

test('browser callback broker records session origins without storing cookies', () => {
  let now = 1_000_000;
  const broker = new BrowserCallbackBroker({ now: () => now, connectionMaxAgeMs: 20_000 });
  broker.heartbeat({ clientId: 'chrome-client-one', browser: 'Chrome' });
  broker.noteSession('chrome-client-one', 'https://agentrouter.org/login');
  assert.equal(broker.hasSession('https://agentrouter.org'), true);
  assert.equal(JSON.stringify(broker.getStatus()).includes('cookie'), false);
  now += 21_000;
  assert.equal(broker.isConnected(), false);
});

test('an explicit companion heartbeat restores and replaces browser session origins', async () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat({
    clientId: 'edge-client-one',
    browser: 'Edge',
    sessions: ['https://anyrouter.top', 'https://agentrouter.org'],
  });
  assert.equal(broker.hasSession('https://anyrouter.top'), true);

  broker.heartbeat({
    clientId: 'edge-client-one',
    browser: 'Edge',
    sessions: ['https://agentrouter.org'],
  });
  assert.equal(broker.hasSession('https://anyrouter.top'), false);
  assert.equal(broker.hasSession('https://agentrouter.org'), true);

  const pending = broker.nextJob({ clientId: 'edge-client-one', browser: 'Edge' }, 1_000);
  assert.equal(broker.hasSession('https://agentrouter.org'), true, 'job polling without a session list must preserve reported sessions');
  broker.close();
  assert.equal(await pending, null);
});

test('broker exposes a new companion generation when its service worker restarts', () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat({
    clientId: 'edge-client-one', browser: 'Edge', version: '0.1.4', instanceId: 'worker-one', sessions: ['https://anyrouter.top'],
  });
  const first = broker.getStatus();

  broker.heartbeat({
    clientId: 'edge-client-one', browser: 'Edge', version: '0.1.4', instanceId: 'worker-one', sessions: ['https://anyrouter.top'],
  });
  assert.equal(broker.getStatus().generation, first.generation);

  broker.heartbeat({
    clientId: 'edge-client-one', browser: 'Edge', version: '0.1.4', instanceId: 'worker-two', sessions: ['https://anyrouter.top'],
  });
  assert.equal(broker.getStatus().generation, first.generation + 1);
});

test('a queued job falls back when its preferred companion does not claim it', async t => {
  let now = 1_000;
  const broker = new BrowserCallbackBroker({ now: () => now, preferredClientGraceMs: 5_000 });
  t.after(() => broker.close());
  broker.heartbeat({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://anyrouter.top'] });
  broker.heartbeat({ clientId: 'chrome-client-two', browser: 'Chrome', sessions: [] });
  const waiting = broker.nextJob({ clientId: 'chrome-client-two', browser: 'Chrome' }, 30_000);
  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  resultPromise.catch(() => {});

  assert.equal(broker.getStatus().queuedJobs, 1, 'the preferred browser gets a short claim window');
  now += 5_001;
  broker.heartbeat({ clientId: 'chrome-client-two', browser: 'Chrome' });
  assert.equal(broker.getStatus().queuedJobs, 0, 'another live browser may claim the abandoned job');

  const job = await waiting;
  assert.equal(job.type, 'query-json');
  broker.complete(job.id, { ok: true, value: { status: 200, text: '{"success":true}' } });
  assert.equal((await resultPromise).status, 200);
});
