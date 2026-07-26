import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCallbackBroker } from '../src/browser-callback-broker.mjs';
import {
  BROWSER_CALLBACK_TIMEOUT_MS,
  COMPANION_PROTOCOL_VERSION,
  companionHandshake,
} from '../browser-companion/protocol.js';

const peer = values => ({ ...companionHandshake(), ...(values || {}) });

test('browser callback broker delivers a query and resolves its callback', async () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat(peer({ clientId: 'edge-client-one', browser: 'Edge', version: '1', sessions: ['https://anyrouter.top'] }));
  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  const job = await broker.nextJob(peer({ clientId: 'edge-client-one', browser: 'Edge' }), 1_000);

  assert.equal(job.type, 'query-json');
  assert.equal(job.protocolVersion, COMPANION_PROTOCOL_VERSION);
  assert.equal(job.request.origin, 'https://anyrouter.top');
  assert.ok(Number.isFinite(Date.parse(job.expiresAt)), 'jobs expose the host callback deadline');
  assert.ok(Date.parse(job.expiresAt) > Date.parse(job.createdAt));
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

test('broker rejects incompatible companion protocols before accepting jobs', () => {
  const broker = new BrowserCallbackBroker();

  assert.throws(() => broker.heartbeat({
    clientId: 'old-edge-client',
    browser: 'Edge',
    protocolVersion: COMPANION_PROTOCOL_VERSION - 1,
    capabilities: [],
  }), /协议不兼容/);
  assert.equal(broker.isConnected(), false);
  assert.match(broker.getStatus().compatibilityError, /协议不兼容/);
  assert.equal(broker.queryTimeoutMs, BROWSER_CALLBACK_TIMEOUT_MS);
});

test('an incompatible reconnect cannot leave an obsolete long poll eligible for jobs', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  const obsolete = broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }), 30_000);

  assert.throws(() => broker.heartbeat({
    clientId: 'edge-client-one',
    browser: 'Edge',
    instanceId: 'worker-two',
    protocolVersion: COMPANION_PROTOCOL_VERSION - 1,
    capabilities: [],
  }), /协议不兼容/);

  assert.equal(await obsolete, null);
  assert.equal(broker.waiters.length, 0);
  assert.equal(broker.isConnected(), false);
});

test('browser callback broker cancels an obsolete queued query immediately', async () => {
  const broker = new BrowserCallbackBroker();
  const controller = new AbortController();
  broker.heartbeat(peer({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://chatgpt.com'] }));
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
  broker.heartbeat(peer({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://chatgpt.com'] }));
  const jobPromise = broker.nextJob(peer({ clientId: 'edge-client-one', browser: 'Edge' }), 1_000);
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
  broker.heartbeat(peer({ clientId: 'chrome-client-one', browser: 'Chrome' }));
  broker.noteSession('chrome-client-one', 'https://agentrouter.org/login');
  assert.equal(broker.hasSession('https://agentrouter.org'), true);
  assert.equal(JSON.stringify(broker.getStatus()).includes('cookie'), false);
  now += 21_000;
  assert.equal(broker.isConnected(), false);
});

test('closing the browser callback broker clears connected clients from status', () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat(peer({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://chatgpt.com'] }));
  assert.equal(broker.getStatus().connected, true);

  broker.close();

  const status = broker.getStatus();
  assert.equal(status.connected, false);
  assert.deepEqual(status.clients, []);
});

test('an explicit companion heartbeat restores and replaces browser session origins', async () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat(peer({
    clientId: 'edge-client-one',
    browser: 'Edge',
    sessions: ['https://anyrouter.top', 'https://agentrouter.org'],
  }));
  assert.equal(broker.hasSession('https://anyrouter.top'), true);

  broker.heartbeat(peer({
    clientId: 'edge-client-one',
    browser: 'Edge',
    sessions: ['https://agentrouter.org'],
  }));
  assert.equal(broker.hasSession('https://anyrouter.top'), false);
  assert.equal(broker.hasSession('https://agentrouter.org'), true);

  const pending = broker.nextJob(peer({ clientId: 'edge-client-one', browser: 'Edge' }), 1_000);
  assert.equal(broker.hasSession('https://agentrouter.org'), true, 'job polling without a session list must preserve reported sessions');
  broker.close();
  assert.equal(await pending, null);
});

test('broker exposes a new companion generation when its service worker restarts', () => {
  const broker = new BrowserCallbackBroker();
  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', version: '0.1.4', instanceId: 'worker-one', sessions: ['https://anyrouter.top'],
  }));
  const first = broker.getStatus();

  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', version: '0.1.4', instanceId: 'worker-one', sessions: ['https://anyrouter.top'],
  }));
  assert.equal(broker.getStatus().generation, first.generation);

  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', version: '0.1.4', instanceId: 'worker-two', sessions: ['https://anyrouter.top'],
  }));
  assert.equal(broker.getStatus().generation, first.generation + 1);
});

test('a replacement service worker cancels the obsolete long poll before dispatching a job', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  const obsolete = broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }), 30_000);

  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-two',
  }));
  assert.equal(await obsolete, null);

  const current = broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-two',
  }), 30_000);
  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  const job = await current;
  assert.equal(job.type, 'query-json');
  broker.complete(job.id, { ok: true, value: { status: 200, text: '{}' } });
  assert.equal((await resultPromise).status, 200);
});

test('a replacement service worker reclaims a job taken by the obsolete instance', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }));
  const resultPromise = broker.queryJson({
    baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self',
  });
  const claimed = await broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }), 1_000);

  assert.equal(broker.getStatus().queuedJobs, 0);
  assert.equal(broker.getStatus().pendingJobs, 1);
  const reclaimed = await broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-two',
  }), 1_000);

  assert.equal(reclaimed.id, claimed.id, 'the original callback identity and deadline must be preserved');
  assert.equal(broker.getStatus().queuedJobs, 0);
  assert.equal(broker.getStatus().pendingJobs, 1);
  broker.complete(reclaimed.id, { ok: true, value: { status: 200, text: '{"success":true}' } });
  assert.equal((await resultPromise).status, 200);
});

test('a late result from the obsolete worker removes its requeued job', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }));
  const resultPromise = broker.queryJson({
    baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self',
  });
  const claimed = await broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }), 1_000);

  broker.heartbeat(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-two',
  }));
  assert.equal(broker.getStatus().queuedJobs, 1);
  assert.equal(broker.complete(claimed.id, { ok: true, value: { status: 200, text: '{}' } }), true);
  assert.equal(broker.getStatus().queuedJobs, 0);
  assert.equal(broker.getStatus().pendingJobs, 0);
  assert.equal((await resultPromise).status, 200);
});

test('an aborted browser long poll is removed without claiming a later job', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  const controller = new AbortController();
  const abandoned = broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }), 30_000, { signal: controller.signal });
  controller.abort();

  assert.equal(await abandoned, null);
  assert.equal(broker.waiters.length, 0);

  const current = broker.nextJob(peer({
    clientId: 'edge-client-one', browser: 'Edge', instanceId: 'worker-one',
  }), 30_000);
  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  const job = await current;
  assert.equal(job.type, 'query-json');
  broker.complete(job.id, { ok: true, value: { status: 200, text: '{}' } });
  await resultPromise;
});

test('a queued job falls back when its preferred companion does not claim it', async t => {
  let now = 1_000;
  const broker = new BrowserCallbackBroker({ now: () => now, preferredClientGraceMs: 5_000 });
  t.after(() => broker.close());
  broker.heartbeat(peer({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://anyrouter.top'] }));
  broker.heartbeat(peer({ clientId: 'chrome-client-two', browser: 'Chrome', sessions: [] }));
  const waiting = broker.nextJob(peer({ clientId: 'chrome-client-two', browser: 'Chrome' }), 30_000);
  const resultPromise = broker.queryJson({ baseUrl: 'https://anyrouter.top', requestPath: '/api/user/self' });
  resultPromise.catch(() => {});

  assert.equal(broker.getStatus().queuedJobs, 1, 'the preferred browser gets a short claim window');
  now += 5_001;
  broker.heartbeat(peer({ clientId: 'chrome-client-two', browser: 'Chrome' }));
  assert.equal(broker.getStatus().queuedJobs, 0, 'another live browser may claim the abandoned job');

  const job = await waiting;
  assert.equal(job.type, 'query-json');
  broker.complete(job.id, { ok: true, value: { status: 200, text: '{"success":true}' } });
  assert.equal((await resultPromise).status, 200);
});

test('targeted browser queries cannot be claimed by another connected browser', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  broker.heartbeat(peer({ clientId: 'edge-client-one', browser: 'Edge', sessions: ['https://welfare.0xpsyche.me'] }));
  broker.heartbeat(peer({ clientId: 'chrome-client-two', browser: 'Chrome', sessions: ['https://welfare.0xpsyche.me'] }));

  const clients = broker.listQueryClients('https://welfare.0xpsyche.me');
  assert.deepEqual(clients.map(client => client.browser).sort(), ['Chrome', 'Edge']);
  assert.ok(clients.every(client => client.hasSession));

  const chromeWaiting = broker.nextJob(peer({ clientId: 'chrome-client-two', browser: 'Chrome' }), 30_000);
  const resultPromise = broker.queryJsonOnClient('edge-client-one', {
    baseUrl: 'https://welfare.0xpsyche.me',
    requestPath: '/api/user/self',
  });
  assert.equal(broker.getStatus().queuedJobs, 1, 'Chrome must not claim an Edge-targeted job');

  const edgeJob = await broker.nextJob(peer({ clientId: 'edge-client-one', browser: 'Edge' }), 1_000);
  assert.equal(edgeJob.type, 'query-json');
  assert.equal(broker.getStatus().queuedJobs, 0);
  broker.complete(edgeJob.id, { ok: true, value: { status: 200, text: '{"success":true}' } });
  assert.equal((await resultPromise).status, 200);

  broker.close();
  assert.equal(await chromeWaiting, null);
});

test('Edge and Chrome remain independent when copied extension storage reused the same client id', async t => {
  const broker = new BrowserCallbackBroker();
  t.after(() => broker.close());
  broker.heartbeat(peer({ clientId: 'shared-client-one', browser: 'Edge', sessions: ['https://welfare.0xpsyche.me'] }));
  broker.heartbeat(peer({ clientId: 'shared-client-one', browser: 'Chrome', sessions: ['https://welfare.0xpsyche.me'] }));

  const status = broker.getStatus();
  assert.deepEqual(status.clients.map(client => client.browser).sort(), ['Chrome', 'Edge']);
  assert.equal(new Set(status.clients.map(client => client.ref)).size, 2);
  assert.equal(JSON.stringify(status).includes('shared-client-one'), false, 'public status exposes only opaque client refs');

  const chrome = broker.listQueryClients().find(client => client.browser === 'Chrome');
  const edgeWaiting = broker.nextJob(peer({ clientId: 'shared-client-one', browser: 'Edge' }), 30_000);
  const chromeWaiting = broker.nextJob(peer({ clientId: 'shared-client-one', browser: 'Chrome' }), 30_000);
  const resultPromise = broker.openLoginOnClient(chrome.clientRef, {
    loginUrl: 'https://welfare.0xpsyche.me/login',
  });
  const job = await chromeWaiting;

  assert.equal(job.type, 'open-login');
  assert.equal(broker.getStatus().queuedJobs, 0, 'the Edge poll must not steal the Chrome login job');
  broker.complete(job.id, { ok: true, value: { opened: true } });
  assert.deepEqual(await resultPromise, { opened: true });
  broker.close();
  assert.equal(await edgeWaiting, null);
});
