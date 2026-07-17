import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { installTargetOnce, settleTargetOperations } from '../src/target-session.mjs';

class FakeCdpClient {
  constructor(version = 0, mounted = version > 0, mountSucceeds = true, visibleComposer = true) {
    this.version = version;
    this.mounted = mounted;
    this.mountSucceeds = mountSucceeds;
    this.visibleComposer = visibleComposer;
    this.closed = false;
    this.expressions = [];
  }

  async evaluate(expression) {
    this.expressions.push(expression);
    if (expression === 'FULL_INJECTOR') {
      this.version = 59;
      this.mounted = this.mountSucceeds;
      return this.mounted;
    }
    if (expression.includes('mounted:')) return { version: this.version, mounted: this.mounted };
    if (expression.includes('?.mount')) {
      this.mounted = this.mountSucceeds;
      return this.mounted;
    }
    if (expression.includes('?.update(')) return true;
    if (expression.includes('contenteditable')) return this.visibleComposer;
    if (expression.includes('document.title')) return true;
    return undefined;
  }

  close() {
    this.closed = true;
  }
}

test('one-shot target install injects, updates, clears an acknowledged action, and closes', async () => {
  const client = new FakeCdpClient();
  const target = { id: 'main', webSocketDebuggerUrl: 'ws://main' };
  const connected = [];

  const result = await installTargetOnce(target, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 59,
    injectorScript: 'FULL_INJECTOR',
    payload: { status: 'ok', used: 10 },
    acknowledgedTitle: 'Codex\u2063\u2063marker',
  }, async url => {
    connected.push(url);
    return client;
  });

  assert.deepEqual(connected, ['ws://main']);
  assert.equal(result.injected, true);
  assert.equal(result.mounted, true);
  assert.equal(client.closed, true);
  assert.equal(client.expressions.filter(item => item === 'FULL_INJECTOR').length, 1);
  assert.equal(client.expressions.filter(item => item.includes('?.update(')).length, 1);
  assert.equal(client.expressions.filter(item => item.includes('if (document.title')).length, 1);
});

test('one-shot target install remounts a matching injector without reinjecting', async () => {
  const client = new FakeCdpClient(59, false);
  const result = await installTargetOnce({ webSocketDebuggerUrl: 'ws://main' }, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 59,
    injectorScript: 'FULL_INJECTOR',
    payload: { status: 'loading' },
  }, async () => client);

  assert.equal(result.injected, false);
  assert.equal(result.mounted, true);
  assert.equal(client.closed, true);
  assert.equal(client.expressions.filter(item => item === 'FULL_INJECTOR').length, 0);
  assert.equal(client.expressions.filter(item => item.includes('?.mount')).length, 1);
});

test('one-shot target install rejects a page where the injector cannot mount', async () => {
  const client = new FakeCdpClient(59, false, false);

  await assert.rejects(
    installTargetOnce({ webSocketDebuggerUrl: 'ws://main' }, {
      globalName: '__TEST_USAGE__',
      injectorVersion: 59,
      injectorScript: 'FULL_INJECTOR',
      payload: { status: 'ok' },
    }, async () => client),
    /找不到可挂载的输入框页脚/,
  );
  assert.equal(client.closed, true);
});

test('one-shot target install allows non-composer pages to remain unmounted', async () => {
  const client = new FakeCdpClient(59, false, false, false);

  const result = await installTargetOnce({ webSocketDebuggerUrl: 'ws://main' }, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 59,
    injectorScript: 'FULL_INJECTOR',
    payload: { status: 'ok' },
  }, async () => client);

  assert.equal(result.mounted, false);
  assert.equal(client.closed, true);
});

test('one-shot target install closes the socket when evaluation fails', async () => {
  const client = new FakeCdpClient();
  client.evaluate = async () => { throw new Error('renderer unavailable'); };

  await assert.rejects(
    installTargetOnce({ webSocketDebuggerUrl: 'ws://main' }, {
      globalName: '__TEST_USAGE__',
      injectorVersion: 59,
      injectorScript: 'FULL_INJECTOR',
      payload: { status: 'loading' },
    }, async () => client),
    /renderer unavailable/,
  );
  assert.equal(client.closed, true);
});

test('one-shot target code never enables Runtime events or installs bindings', () => {
  const source = fs.readFileSync(new URL('../src/target-session.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /Runtime\.enable/);
  assert.doesNotMatch(source, /Runtime\.addBinding/);
  assert.doesNotMatch(source, /Runtime\.bindingCalled/);
  assert.doesNotMatch(source, /executionContextsCleared/);
});

test('target operations start concurrently and preserve isolated failures', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const started = [];
  const pending = settleTargetOperations([1, 2, 3], async value => {
    started.push(value);
    if (value === 1) await firstGate;
    if (value === 2) throw new Error('target unavailable');
    return value * 10;
  });

  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3], 'later targets must start while the first target is blocked');
  releaseFirst();
  const results = await pending;

  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[0].value, 10);
  assert.equal(results[2].value, 30);
});
