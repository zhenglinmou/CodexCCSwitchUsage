import assert from 'node:assert/strict';
import test from 'node:test';
import { TargetDiscovery } from '../src/target-discovery.mjs';

class FakeClient {
  constructor() {
    this.listeners = new Map();
    this.closeListeners = new Set();
    this.calls = [];
    this.closed = false;
  }

  on(method, listener) {
    this.listeners.set(method, listener);
  }

  off(method) {
    this.listeners.delete(method);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
  }

  offClose(listener) {
    this.closeListeners.delete(listener);
  }

  async call(method, params) {
    this.calls.push({ method, params });
  }

  emit(method, params = {}) {
    this.listeners.get(method)?.(params);
  }

  emitClose(error = new Error('closed')) {
    for (const listener of this.closeListeners) listener(error);
  }

  close() {
    this.closed = true;
  }
}

test('target discovery requests browser events and reports target lifecycle changes', async () => {
  const client = new FakeClient();
  let changes = 0;
  const discovery = new TargetDiscovery(client, () => { changes += 1; }, { debounceMs: 10 });

  await discovery.start();
  client.emit('Target.targetCreated', { targetInfo: { targetId: 'worker', type: 'worker', url: 'app://worker' } });
  client.emit('Target.targetCreated', { targetInfo: { targetId: 'web', type: 'page', url: 'https://example.com' } });
  client.emit('Target.targetCreated', { targetInfo: { targetId: 'one', type: 'page', url: 'app://codex' } });
  client.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'one', type: 'page', url: 'app://codex/task' } });
  client.emit('Target.targetDestroyed', { targetId: 'one' });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.deepEqual(client.calls, [{ method: 'Target.setDiscoverTargets', params: { discover: true } }]);
  assert.equal(changes, 1, 'a burst of relevant page events should produce one synchronization');
  client.emit('Target.targetDestroyed', { targetId: 'worker' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(changes, 1, 'untracked worker events must be ignored');
  discovery.close();
  assert.equal(client.closed, true);
});

test('target discovery follows a child window while it initializes from about:blank', async () => {
  const client = new FakeClient();
  let changes = 0;
  const discovery = new TargetDiscovery(client, () => { changes += 1; }, { debounceMs: 10 });
  await discovery.start();

  client.emit('Target.targetCreated', { targetInfo: { targetId: 'child', type: 'page', url: 'about:blank' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  client.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'child', type: 'page', url: 'app://-/index.html' } });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(changes, 2);
  discovery.close();
});

test('target discovery drops the avatar overlay after its initializing route resolves', async () => {
  const client = new FakeClient();
  let changes = 0;
  const discovery = new TargetDiscovery(client, () => { changes += 1; }, { debounceMs: 10 });
  await discovery.start();

  client.emit('Target.targetCreated', { targetInfo: { targetId: 'avatar', type: 'page', url: 'about:blank' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  client.emit('Target.targetInfoChanged', {
    targetInfo: { targetId: 'avatar', type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' },
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(changes, 2);
  assert.equal(discovery.trackedTargetIds.has('avatar'), false);
  discovery.close();
});

test('target discovery reports unexpected browser disconnects but ignores intentional close', async () => {
  const client = new FakeClient();
  const disconnects = [];
  const discovery = new TargetDiscovery(client, () => {}, {
    onDisconnect: error => disconnects.push(error.message),
  });
  await discovery.start();

  client.emitClose(new Error('browser closed'));
  discovery.close();
  client.emitClose(new Error('intentional close'));

  assert.deepEqual(disconnects, ['browser closed']);
});
