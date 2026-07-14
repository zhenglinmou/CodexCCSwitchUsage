import assert from 'node:assert/strict';
import test from 'node:test';
import { disposeTargetInjector, settleTargetOperations, TargetSession } from '../src/target-session.mjs';

class FakeCdpClient {
  constructor(version = 0) {
    this.version = version;
    this.mounted = version > 0;
    this.closed = false;
    this.expressions = [];
    this.calls = [];
    this.listeners = new Map();
  }

  async call(method, params) {
    this.calls.push({ method, params });
  }

  on(method, listener) {
    this.listeners.set(method, listener);
  }

  off(method) {
    this.listeners.delete(method);
  }

  emit(method, params = {}) {
    this.listeners.get(method)?.(params);
  }

  async evaluate(expression) {
    this.expressions.push(expression);
    if (expression === 'FULL_INJECTOR') {
      this.version = 31;
      this.mounted = true;
      return true;
    }
    if (expression.includes('mounted:')) return { version: this.version, mounted: this.mounted };
    if (expression.includes('?.version')) return this.version;
    if (expression.includes('?.mount')) {
      this.mounted = true;
      return true;
    }
    if (expression.includes('?.update(')) return true;
    if (expression.includes('getRefreshRequest')) return { token: 7, requestedAt: 123 };
    if (expression.includes('delete window')) return true;
    return undefined;
  }

  close() {
    this.closed = true;
  }
}

test('target session injects once and hot-updates only changed payloads', async () => {
  const client = new FakeCdpClient();
  const session = new TargetSession(client, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 31,
    injectorScript: 'FULL_INJECTOR',
  });
  const firstPayload = { status: 'ok', used: 10 };

  assert.equal(await session.ensureInjector(), true);
  assert.equal(await session.updatePayload(firstPayload), true);
  assert.equal(await session.ensureInjector(), false);
  assert.equal(await session.updatePayload({ status: 'ok', used: 10 }), false);

  assert.equal(client.expressions.filter(item => item === 'FULL_INJECTOR').length, 1);
  assert.equal(client.expressions.filter(item => item.includes('?.update(')).length, 1);

  assert.equal(await session.updatePayload({ status: 'ok', used: 11 }), true);
  assert.equal(client.expressions.filter(item => item.includes('?.update(')).length, 2);
});

test('target session reinjects a changed script version and redelivers the payload', async () => {
  const client = new FakeCdpClient(30);
  const session = new TargetSession(client, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 31,
    injectorScript: 'FULL_INJECTOR',
  });
  const payload = { status: 'ok', used: 10 };

  await session.ensureInjector();
  await session.updatePayload(payload);
  client.version = 30;

  assert.equal(await session.ensureInjector(), true);
  assert.equal(await session.updatePayload(payload), true);
  assert.equal(client.expressions.filter(item => item === 'FULL_INJECTOR').length, 2);
  assert.equal(client.expressions.filter(item => item.includes('?.update(')).length, 2);
});

test('target session remounts a matching injector whose DOM root was detached', async () => {
  const client = new FakeCdpClient(31);
  client.mounted = false;
  const session = new TargetSession(client, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 31,
    injectorScript: 'FULL_INJECTOR',
  });

  assert.equal(await session.ensureInjector(), false);
  assert.equal(client.mounted, true);
  assert.equal(client.expressions.filter(item => item === 'FULL_INJECTOR').length, 0);
  assert.equal(client.expressions.filter(item => item.includes('?.mount')).length, 1);
});

test('target session reads refresh requests with a lightweight expression', async () => {
  const client = new FakeCdpClient(31);
  const session = new TargetSession(client, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 31,
    injectorScript: 'FULL_INJECTOR',
  });

  assert.deepEqual(await session.getRefreshRequest(), { token: 7, requestedAt: 123 });
  assert.equal(client.expressions.length, 1);
  assert.match(client.expressions[0], /getRefreshRequest/);
});

test('auxiliary target cleanup removes observers, events and injected DOM', async () => {
  const client = new FakeCdpClient(31);

  assert.equal(await disposeTargetInjector(client, '__TEST_USAGE__'), true);
  assert.equal(client.expressions.length, 1);
  assert.match(client.expressions[0], /eventController\?\.abort\(\)/);
  assert.match(client.expressions[0], /observer\?\.disconnect\(\)/);
  assert.match(client.expressions[0], /resizeObserver\?\.disconnect\(\)/);
  assert.match(client.expressions[0], /state\.root\?\.remove\(\)/);
  assert.match(client.expressions[0], /delete window\["__TEST_USAGE__"\]/);
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

test('target session receives refresh clicks through a Runtime binding', async () => {
  const client = new FakeCdpClient(31);
  const refreshes = [];
  let contextResets = 0;
  const session = new TargetSession(client, {
    globalName: '__TEST_USAGE__',
    injectorVersion: 31,
    injectorScript: 'FULL_INJECTOR',
    refreshBindingName: '__TEST_REFRESH__',
    onRefresh: payload => refreshes.push(payload),
    onContextReset: () => { contextResets += 1; },
  });

  await session.initialize();
  client.emit('Runtime.bindingCalled', { name: '__TEST_REFRESH__', payload: '{"token":4}' });
  client.emit('Runtime.executionContextsCleared');

  assert.deepEqual(client.calls, [
    { method: 'Runtime.enable', params: {} },
    { method: 'Runtime.addBinding', params: { name: '__TEST_REFRESH__' } },
  ]);
  assert.deepEqual(refreshes, [{ token: 4 }]);
  assert.equal(contextResets, 1);
});
