import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getOrCreateHubToken, HubServer } from '../src/hub-server.mjs';

test('Hub path token persists across host restarts without becoming guessable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'hub-token');

  const first = getOrCreateHubToken(filename);
  const second = getOrCreateHubToken(filename);

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
});

test('Hub server protects its local page and API with an unguessable path token', async t => {
  let refreshAllCalls = 0;
  const service = {
    syncProviders() {},
    getState: () => ({ version: 2, providers: [] }),
    refreshAll() { refreshAllCalls += 1; return Promise.resolve(); },
    refreshProvider: () => Promise.resolve(),
    openLogin: () => Promise.resolve({ id: 'one' }),
  };
  const server = new HubServer(service, { port: 0, token: 'test-token', openUrl() {} });
  await server.start();
  t.after(() => server.close());

  const page = await fetch(server.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /Balance Hub/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|access_token/);

  const state = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/state`);
  assert.deepEqual(await state.json(), { version: 2, providers: [] });
  const rejected = await fetch(`http://127.0.0.1:${server.boundPort}/api/wrong/state`);
  assert.equal(rejected.status, 404);

  const refresh = await fetch(`http://127.0.0.1:${server.boundPort}/api/test-token/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(refresh.status, 202);
  assert.ok(refreshAllCalls >= 1);
});
