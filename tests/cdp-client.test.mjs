import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient, hasAuxiliaryPageTargets, isCodexTargetCandidate } from '../src/cdp-client.mjs';

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.closeCalls = 0;
  }

  addEventListener(name, listener, options = {}) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push({ listener, once: Boolean(options.once) });
  }

  removeEventListener(name, listener) {
    const listeners = this.listeners.get(name);
    if (!listeners) return;
    const remaining = listeners.filter(entry => entry.listener !== listener);
    if (remaining.length > 0) this.listeners.set(name, remaining);
    else this.listeners.delete(name);
  }

  listenerCount(name) {
    return this.listeners.get(name)?.length || 0;
  }

  emit(name, event = {}) {
    for (const entry of [...(this.listeners.get(name) || [])]) {
      if (entry.once) this.removeEventListener(name, entry.listener);
      entry.listener(event);
    }
  }

  send() {}
  close() {
    this.closeCalls += 1;
  }
}

function installFakeWebSocket() {
  const hadOwnWebSocket = Object.hasOwn(globalThis, 'WebSocket');
  const originalWebSocket = globalThis.WebSocket;
  let socket;

  globalThis.WebSocket = class extends FakeSocket {
    constructor(url) {
      super();
      this.url = url;
      socket = this;
    }
  };

  return {
    get socket() {
      return socket;
    },
    restore() {
      if (hadOwnWebSocket) globalThis.WebSocket = originalWebSocket;
      else delete globalThis.WebSocket;
    },
  };
}

test('CDP connect closes its unowned socket and removes handshake listeners on timeout', async () => {
  const fake = installFakeWebSocket();
  try {
    await assert.rejects(
      CdpClient.connect('ws://127.0.0.1/devtools/page/timeout', 1),
      { message: '连接 Codex 调试接口超时' },
    );

    assert.equal(fake.socket.closeCalls, 1);
    assert.equal(fake.socket.listenerCount('open'), 0);
    assert.equal(fake.socket.listenerCount('error'), 0);
  } finally {
    fake.restore();
  }
});

test('CDP connect closes its unowned socket and removes handshake listeners on error', async () => {
  const fake = installFakeWebSocket();
  try {
    const connecting = CdpClient.connect('ws://127.0.0.1/devtools/page/error');
    const rejected = assert.rejects(connecting, { message: '无法连接 Codex 调试接口' });
    fake.socket.emit('error');
    await rejected;

    assert.equal(fake.socket.closeCalls, 1);
    assert.equal(fake.socket.listenerCount('open'), 0);
    assert.equal(fake.socket.listenerCount('error'), 0);
  } finally {
    fake.restore();
  }
});

test('CDP client dispatches notification events independently from call responses', () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const received = [];
  const listener = params => received.push(params);

  client.on('Runtime.bindingCalled', listener);
  socket.emit('message', {
    data: JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'refresh', payload: '{}' } }),
  });
  client.off('Runtime.bindingCalled', listener);
  socket.emit('message', {
    data: JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'refresh', payload: 'ignored' } }),
  });

  assert.deepEqual(received, [{ name: 'refresh', payload: '{}' }]);
});

test('CDP client notifies close subscribers once', () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const closed = [];
  const listener = error => closed.push(error.message);

  client.onClose(listener);
  socket.emit('close');
  socket.emit('error');

  assert.deepEqual(closed, ['Codex 调试连接已关闭']);
  assert.equal(client.closed, true);
});

test('Codex target candidates accept only the confirmed primary app document', () => {
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://-/index.html' }), true);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'about:blank' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: '' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://codex' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://-/index.html#plugin' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://-/index.html?initialRoute=%2Fplugins' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'https://example.com' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'worker', url: 'app://-/worker.js' }), false);
});

test('auxiliary browser pages block one-shot injection while workers do not', () => {
  assert.equal(hasAuxiliaryPageTargets([
    { type: 'page', url: 'app://-/index.html' },
    { type: 'worker', url: 'app://-/worker.js' },
  ]), false);
  assert.equal(hasAuxiliaryPageTargets([
    { type: 'page', url: 'app://-/index.html' },
    { type: 'page', url: 'about:blank' },
  ]), true);
  assert.equal(hasAuxiliaryPageTargets([
    { type: 'page', url: 'app://-/index.html' },
    { type: 'webview', url: 'https://example.com/' },
  ]), true);
});
