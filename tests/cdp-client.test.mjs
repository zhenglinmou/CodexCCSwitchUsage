import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { CdpClient, closeCdpHttpClient, listCdpTargets } from '../src/cdp-client.mjs';

test('CDP calls release pending state when WebSocket send fails synchronously', async () => {
  class ThrowingSocket extends EventTarget {
    send() {
      throw new Error('socket send failed');
    }

    close() {
      this.dispatchEvent(new Event('close'));
    }
  }

  const client = new CdpClient(new ThrowingSocket());
  try {
    await assert.rejects(client.call('Runtime.evaluate'), /socket send failed/);
    assert.equal(client.pending.size, 0);
  } finally {
    client.close();
  }
});

test('CDP WebSocket transport refuses non-loopback targets', async () => {
  await assert.rejects(CdpClient.connect('ws://example.com/devtools/page/test'), /本机允许列表/);
});

test('CDP uses a masked loopback WebSocket and parses its response', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const request = buffer.subarray(0, boundary).toString('latin1');
        buffer = buffer.subarray(boundary + 4);
        const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim();
        const accept = crypto.createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      if (!upgraded || buffer.length < 6) return;
      const length = buffer[1] & 0x7f;
      assert.ok(length < 126, 'fixture request should use the short frame form');
      assert.equal(Boolean(buffer[1] & 0x80), true, 'client frames must be masked');
      if (buffer.length < 6 + length) return;
      const mask = buffer.subarray(2, 6);
      const payload = Buffer.from(buffer.subarray(6, 6 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      buffer = buffer.subarray(6 + length);
      const request = JSON.parse(payload.toString('utf8'));
      const responsePayload = Buffer.from(JSON.stringify({ id: request.id, result: { answer: 2 } }));
      socket.write(Buffer.concat([Buffer.from([0x81, responsePayload.length]), responsePayload]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  const client = await CdpClient.connect(`ws://127.0.0.1:${server.address().port}/devtools/page/test`, 1_000);
  try {
    assert.deepEqual(await client.call('Runtime.evaluate', { expression: '1+1' }), { answer: 2 });
  } finally {
    client.close();
  }
});

test('a timed-out CDP WebSocket handshake releases its TCP connection', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
    // Deliberately never answer the WebSocket upgrade request.
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  const connected = once(server, 'connection');
  const port = server.address().port;
  const pending = CdpClient.connect(`ws://127.0.0.1:${port}/devtools/page/stalled`, 200);
  await connected;
  await assert.rejects(pending, /超时/);

  const deadline = Date.now() + 500;
  while (sockets.size > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(sockets.size, 0, 'terminating the handshake transport must close the underlying TCP socket');
});

test('CDP rejects masked server frames', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const request = buffer.subarray(0, boundary).toString('latin1');
        buffer = buffer.subarray(boundary + 4);
        const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim();
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      if (!upgraded || buffer.length < 6) return;
      const length = buffer[1] & 0x7f;
      if (buffer.length < 6 + length) return;
      const mask = buffer.subarray(2, 6);
      const requestPayload = Buffer.from(buffer.subarray(6, 6 + length));
      for (let index = 0; index < requestPayload.length; index += 1) requestPayload[index] ^= mask[index % 4];
      const request = JSON.parse(requestPayload.toString('utf8'));
      const responsePayload = Buffer.from(JSON.stringify({ id: request.id, result: {} }));
      const responseMask = Buffer.from([1, 2, 3, 4]);
      const maskedPayload = Buffer.from(responsePayload);
      for (let index = 0; index < maskedPayload.length; index += 1) maskedPayload[index] ^= responseMask[index % 4];
      socket.write(Buffer.concat([
        Buffer.from([0x81, 0x80 | responsePayload.length]),
        responseMask,
        maskedPayload,
      ]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  const client = await CdpClient.connect(`ws://127.0.0.1:${server.address().port}/devtools/page/masked`, 1_000);
  await assert.rejects(client.call('Runtime.evaluate'), /Codex 调试连接/);
  assert.equal(client.pending.size, 0);
});

test('CDP target snapshots reject WebSocket URLs on a different loopback port', async t => {
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    const wrongPort = port === 65_535 ? port - 1 : port + 1;
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify([{
      id: 'page-one',
      type: 'page',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${wrongPort}/devtools/page/page-one`,
    }]));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  await assert.rejects(listCdpTargets(server.address().port), /不属于当前本机端口/);
});

test('CDP target snapshots reuse one bounded HTTP connection and release it on close', async () => {
  let connections = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('[]');
  });
  server.on('connection', socket => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    assert.deepEqual(await listCdpTargets(port), []);
    assert.deepEqual(await listCdpTargets(port), []);
    assert.equal(connections, 1);

    const [socket] = sockets;
    const closed = once(socket, 'close');
    closeCdpHttpClient();
    await closed;
    assert.equal(sockets.size, 0);
    await assert.rejects(listCdpTargets(port), /HTTP 客户端已关闭/);
    assert.equal(connections, 1);
  } finally {
    closeCdpHttpClient();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
