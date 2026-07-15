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
} from '../browser-companion/session-state.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(name => name in data).map(name => [name, data[name]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
  };
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
  assert.match(source, /await heartbeat\(\)\.catch\(\(\) => \{\}\);/);
});

test('only an explicit login job may create or focus a website tab', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const query = source.slice(source.indexOf('async function queryThroughCurrentBrowser('), source.indexOf('async function openLogin('));
  const login = source.slice(source.indexOf('async function openLogin('), source.indexOf('async function executeJob('));

  assert.doesNotMatch(query, /chrome\.tabs\.(?:create|update)/);
  assert.match(login, /chrome\.tabs\.update/);
  assert.match(login, /chrome\.tabs\.create/);
});

test('explicit New API session sync persists an id through an inactive temporary tab', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('async function syncNewApiSession('), source.indexOf('async function openLogin('));
  const login = source.slice(source.indexOf('async function openLogin('), source.indexOf('async function executeJob('));

  assert.match(login, /if \(request\.userHeader\) return syncNewApiSession\(request, deadline\)/);
  assert.match(sync, /chrome\.tabs\.create\(\{ url: origin, active: false \}\)/);
  assert.match(sync, /browserSessionUserId\(request, result\)/);
  assert.match(sync, /sessionIdentities\.remember\(origin, userId\)/);
  assert.match(sync, /sessionHints\.remember\(origin\)/);
  assert.match(sync, /chrome\.tabs\.remove\(temporaryTab\.id\)/);
  assert.doesNotMatch(sync, /active:\s*true|focused:\s*true/);
});

test('successful browser queries remember user identity and explicit auth failures clear it', () => {
  const source = fs.readFileSync(new URL('../browser-companion/background.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollOnce('), source.indexOf('async function startPolling('));

  assert.match(poll, /browserSessionUserId\(job\.request, value\)/);
  assert.match(poll, /sessionIdentities\.remember/);
  assert.match(poll, /outcome === 'invalid'[\s\S]*sessionIdentities\.forget/);
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
