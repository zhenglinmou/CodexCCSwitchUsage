import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient, isCodexAuxiliaryTarget, isCodexTargetCandidate } from '../src/cdp-client.mjs';

class FakeSocket {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  emit(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  send() {}
  close() {}
}

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

test('Codex target candidates include initializing child windows', () => {
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://-/index.html' }), true);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'about:blank' }), true);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: '' }), true);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'page', url: 'https://example.com' }), false);
  assert.equal(isCodexTargetCandidate({ type: 'worker', url: 'app://-/worker.js' }), false);
  assert.equal(isCodexAuxiliaryTarget({ type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }), true);
  assert.equal(isCodexAuxiliaryTarget({ type: 'page', url: 'about:blank' }), false);
});
