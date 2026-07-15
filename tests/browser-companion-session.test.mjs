import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  browserJobTimeout,
  browserSessionOutcome,
  browserSessionUserId,
  normalizeSessionOrigins,
  selectReadySessionTab,
  SessionHintStore,
  SessionIdentityStore,
  TrailingSingleFlight,
} from '../browser-companion/session-state.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(name => name in data).map(name => [name, data[name]]));
    },
    async set(values) {
      writes.push({ ...values });
      Object.assign(data, values);
    },
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

test('browser companion persists only validated origin hints across service-worker restarts', async () => {
  const storage = memoryStorage();
  const firstWorker = new SessionHintStore(storage);

  await firstWorker.remember('https://anyrouter.top/path?token=private');
  await firstWorker.remember('https://untrusted.example');

  const restartedWorker = new SessionHintStore(storage);
  assert.deepEqual(await restartedWorker.list(), ['https://anyrouter.top']);
  assert.deepEqual(storage.data.validatedSessionOrigins, ['https://anyrouter.top']);
  assert.doesNotMatch(JSON.stringify(storage.data), /private|cookie|bearer|token/i);

  await restartedWorker.forget('https://anyrouter.top');
  assert.deepEqual(await restartedWorker.list(), []);
});

test('browser companion persists only the numeric New API user id needed beside Edge cookies', async () => {
  const storage = memoryStorage();
  const firstWorker = new SessionIdentityStore(storage);

  await firstWorker.remember('https://anyrouter.top/path', 42);
  await firstWorker.remember('https://agentrouter.org', '007');
  await firstWorker.remember('https://untrusted.example', 99);
  await firstWorker.remember('https://anyrouter.top', 'Bearer private-token');

  const restartedWorker = new SessionIdentityStore(storage);
  assert.equal(await restartedWorker.get('https://anyrouter.top'), '42');
  assert.equal(await restartedWorker.get('https://agentrouter.org'), '7');
  assert.deepEqual(storage.data.sessionUserIds, {
    'https://agentrouter.org': '7',
    'https://anyrouter.top': '42',
  });
  assert.doesNotMatch(JSON.stringify(storage.data), /cookie|bearer|private-token/i);

  await restartedWorker.forget('https://anyrouter.top');
  assert.equal(await restartedWorker.get('https://anyrouter.top'), '');
});

test('browser companion skips unchanged session hint and user id writes', async () => {
  const storage = memoryStorage({
    validatedSessionOrigins: ['https://anyrouter.top'],
    sessionUserIds: { 'https://anyrouter.top': '42' },
  });
  const hints = new SessionHintStore(storage);
  const identities = new SessionIdentityStore(storage);

  await hints.remember('https://anyrouter.top/path');
  await hints.forget('https://agentrouter.org');
  await identities.remember('https://anyrouter.top', 42);
  await identities.forget('https://agentrouter.org');
  assert.equal(storage.writes.length, 0);

  await hints.remember('https://agentrouter.org');
  await identities.remember('https://anyrouter.top', 43);
  assert.equal(storage.writes.length, 2);
});

test('unchanged session updates still clean legacy and non-allowlisted storage values', async () => {
  const storage = memoryStorage({
    validatedSessionOrigins: [
      'https://anyrouter.top/path',
      'https://untrusted.example',
    ],
    sessionUserIds: {
      'https://anyrouter.top': '042',
      'https://untrusted.example': '99',
    },
  });
  const hints = new SessionHintStore(storage);
  const identities = new SessionIdentityStore(storage);

  await hints.remember('https://anyrouter.top');
  await identities.remember('https://anyrouter.top', 42);

  assert.deepEqual(storage.data.validatedSessionOrigins, ['https://anyrouter.top']);
  assert.deepEqual(storage.data.sessionUserIds, { 'https://anyrouter.top': '42' });
  assert.equal(storage.writes.length, 2);
});

test('trailing single-flight runs immediately and preserves one debounced trailing update', async () => {
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const control = new TrailingSingleFlight(async value => {
    calls.push(value);
    if (calls.length === 1) await firstBlocked;
    return value;
  }, 5);

  const first = control.runNow('first');
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);

  control.schedule('stale');
  control.schedule('latest');
  await delay(10);
  assert.deepEqual(calls, ['first'], 'the trailing task must not overlap the active task');

  releaseFirst();
  assert.equal(await first, 'first');
  await delay(0);
  assert.deepEqual(calls, ['first', 'latest']);
});

test('an explicit run during a flight queues the latest arguments and remains awaitable', async () => {
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const control = new TrailingSingleFlight(async token => {
    calls.push(token);
    if (calls.length === 1) await firstBlocked;
    return token;
  }, 5);

  const first = control.runNow('old-token');
  await Promise.resolve();
  const queued = control.runNow('stale-token');
  const latest = control.runNow('new-token');
  assert.notStrictEqual(queued, first);
  assert.strictEqual(latest, queued);

  releaseFirst();
  assert.equal(await first, 'old-token');
  assert.equal(await queued, 'new-token');
  assert.deepEqual(calls, ['old-token', 'new-token']);
});

test('browser session outcome retains successful New API sessions and clears real authentication failures', () => {
  const request = { baseUrl: 'https://anyrouter.top', userHeader: 'New-Api-User' };
  assert.equal(browserSessionOutcome(request, {
    status: 200,
    text: '{"success":true,"data":{"quota":500000}}',
  }), 'valid');
  assert.equal(browserSessionOutcome(request, {
    status: 401,
    text: '{"success":false,"message":"unauthorized"}',
  }), 'invalid');
  assert.equal(browserSessionOutcome(request, {
    status: 200,
    text: '{"success":false,"message":"not logged in"}',
  }), 'invalid');
  assert.equal(browserSessionOutcome(request, {
    status: 200,
    text: '{"success":false,"message":"temporary upstream error"}',
  }), null, 'ordinary provider errors must not erase a valid login hint');
  assert.equal(browserSessionOutcome(request, {
    status: 0,
    text: '<html>temporary WAF challenge</html>',
  }), null, 'transient transport and WAF failures must not erase a persisted login hint');
  assert.equal(browserSessionOutcome(request, {
    status: 403,
    text: '<html>Cloudflare challenge</html>',
  }), null, 'a WAF HTTP 403 without an authentication payload must remain transient');
  assert.equal(browserSessionOutcome(request, {
    status: 403,
    text: '{"success":false,"message":"Cloudflare challenge required"}',
  }), null, 'a structured WAF 403 must not erase a persisted identity');
});

test('browser session user id is extracted only from a successful matching New API response', () => {
  const request = { baseUrl: 'https://anyrouter.top', userHeader: 'New-Api-User' };
  assert.equal(browserSessionUserId(request, {
    status: 200,
    text: '{"success":true,"data":{"id":42,"quota":500000}}',
  }), '42');
  assert.equal(browserSessionUserId(request, {
    status: 200,
    text: '{"success":false,"data":{"id":42}}',
  }), '');
  assert.equal(browserSessionUserId({ baseUrl: 'https://chatgpt.com' }, {
    status: 200,
    text: '{"success":true,"data":{"id":42}}',
  }), '');
});

test('browser companion refreshes through the extension worker without opening a website tab', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(new URL('../browser-companion/manifest.json', import.meta.url), 'utf8'));
  const query = source.slice(source.indexOf('async function queryThroughCurrentBrowser('), source.indexOf('async function openLogin('));

  assert.equal(manifest.background.type, 'module');
  assert.match(source, /new SessionHintStore\(chrome\.storage\.local\)/);
  assert.match(source, /new SessionIdentityStore\(chrome\.storage\.local\)/);
  assert.match(source, /const instanceId = crypto\.randomUUID\(\);/);
  assert.match(source, /instanceId,/);
  assert.match(query, /fetchFromExtension\(request,/);
  assert.match(query, /identityMissing/);
  assert.match(source, /credentials: 'include'/);
  assert.doesNotMatch(query, /queryInTemporaryTab|chrome\.tabs\.(?:create|update)/);
  assert.doesNotMatch(source, /tabSessionCandidates/);
  assert.doesNotMatch(source, /if \(value\?\.origin\) await notifySession/);
});

test('browser companion silently reuses an awake completed session tab without requiring focus', () => {
  assert.equal(selectReadySessionTab([
    { id: 1, active: false, status: 'complete', discarded: false, frozen: false },
    { id: 2, active: true, status: 'complete', discarded: true, frozen: false },
    { id: 3, active: true, status: 'loading', discarded: false, frozen: false },
  ])?.id, 1);

  assert.equal(selectReadySessionTab([
    { id: 4, active: true, status: 'complete', discarded: false, frozen: false, lastAccessed: 10 },
    { id: 5, active: true, status: 'complete', discarded: false, frozen: false, lastAccessed: 20 },
  ])?.id, 5);
});

test('browser companion bounds a whole provider job and the in-page fetch', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');

  assert.equal(browserJobTimeout({ waitMs: 55_000 }), 35_000);
  assert.equal(browserJobTimeout({ waitMs: 1_000 }), 5_000);
  assert.equal(browserJobTimeout({}), 30_000);
  assert.match(source, /const timeoutMs = browserJobTimeout\(job\.request\);/);
  assert.match(source, /await withTimeout\(executeJob\(job, deadline\), timeoutMs \+ 1_000/);
  assert.match(source, /const controller = new AbortController\(\);/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /scheduleHeartbeat\(\);/);
});

test('only an explicit login job may create or focus a website tab', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const query = source.slice(source.indexOf('async function queryThroughCurrentBrowser('), source.indexOf('async function openLogin('));
  const login = source.slice(source.indexOf('async function openLogin('), source.indexOf('async function executeJob('));

  assert.doesNotMatch(query, /chrome\.tabs\.(?:create|update)/);
  assert.match(login, /focusLoginPage\(request\)/);
  assert.match(source, /chrome\.tabs\.update/);
  assert.match(source, /chrome\.tabs\.create/);
});

test('explicit New API session repair uses an existing tab or visibly opens the official login page', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('async function syncNewApiSession('), source.indexOf('async function openLogin('));
  const login = source.slice(source.indexOf('async function openLogin('), source.indexOf('async function executeJob('));

  assert.match(login, /if \(request\.userHeader\) return syncNewApiSession\(request, deadline\)/);
  assert.match(sync, /focusLoginPage\(request\)/);
  assert.match(sync, /browserSessionUserId\(request, result\)/);
  assert.match(sync, /sessionIdentities\.remember\(origin, userId\)/);
  assert.match(sync, /sessionHints\.remember\(origin\)/);
  assert.doesNotMatch(sync, /temporaryTab|active:\s*false/);
  assert.match(source, /chrome\.tabs\.create\(\{ url: loginUrl, active: true \}\)/);
  assert.match(source, /chrome\.windows\.update\([^)]*\{ focused: true \}/);
});

test('successful browser queries remember user identity and explicit auth failures clear it', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollOnce('), source.indexOf('async function startPolling('));

  assert.match(poll, /browserSessionUserId\(job\.request, value\)/);
  assert.match(poll, /sessionIdentities\.remember/);
  assert.match(poll, /outcome === 'invalid'[\s\S]*sessionIdentities\.forget/);
});

test('idle job polling announces persisted sessions once instead of re-reading them for every long poll', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollOnce('), source.indexOf('async function startPolling('));
  const polling = source.slice(source.indexOf('async function startPolling('), source.indexOf('chrome.runtime.onInstalled'));

  assert.doesNotMatch(poll, /knownSessions\(\)/);
  assert.match(polling, /await heartbeat\(current\)/);
  assert.match(polling, /await pollOnce\(current\)/);
  assert.match(source, /periodInMinutes:\s*1/);
  assert.equal((source.match(/chrome\.alarms\.create\(POLL_ALARM/g) || []).length, 1);
});

test('each polling iteration reuses one config and persists lastError only when it changes', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollOnce('), source.indexOf('async function startPolling('));
  const polling = source.slice(source.indexOf('async function startPolling('), source.indexOf('async function wake('));
  const status = source.slice(source.indexOf('function updateStatus('), source.indexOf('function apiUrl('));

  assert.match(poll, /async function pollOnce\(current\)/);
  assert.doesNotMatch(poll, /\bconfig\(\)/);
  assert.match(polling, /const current = nextConfig \|\| await config\(\)/);
  assert.match(polling, /await heartbeat\(current\)/);
  assert.match(polling, /await pollOnce\(current\)/);
  assert.match(status, /nextLastError !== lastErrorValue/);
  assert.match(source, /lastErrorValue = String\(stored\.lastError \|\| ''\)/);
  assert.doesNotMatch(source, /if \(lastErrorValue === undefined\) lastErrorValue = String\(stored\.lastError/);
  assert.doesNotMatch(source, /chrome\.storage\.local\.set\(\{\s*lastError:/);
});

test('event heartbeats are 350ms trailing single-flight while startup and wake stay immediate and awaitable', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const listeners = source.slice(source.indexOf('chrome.cookies.onChanged'), source.indexOf('chrome.alarms.create'));
  const wake = source.slice(source.indexOf('async function wake('), source.indexOf('chrome.runtime.onInstalled'));

  assert.match(source, /const HEARTBEAT_DEBOUNCE_MS = 350/);
  assert.match(source, /new TrailingSingleFlight\(performHeartbeat, HEARTBEAT_DEBOUNCE_MS\)/);
  assert.equal((listeners.match(/scheduleHeartbeat\(\)/g) || []).length, 2);
  assert.match(wake, /const result = await heartbeat\(current\)/);
  assert.match(listeners, /wake\(\)\.then\(sendResponse/);
  assert.match(source, /if \(announceSessions\)[\s\S]*await heartbeat\(current\)/);
});

test('session origin normalization accepts only the companion allowlist', () => {
  assert.deepEqual(normalizeSessionOrigins([
    'https://anyrouter.top/path',
    'https://agentrouter.org',
    'http://anyrouter.top',
    'https://untrusted.example',
    'https://anyrouter.top',
  ]), ['https://anyrouter.top', 'https://agentrouter.org']);
});
