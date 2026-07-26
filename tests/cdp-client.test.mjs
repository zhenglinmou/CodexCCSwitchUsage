import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { closeCdpHttpClient, listCdpTargets } from '../src/cdp-client.mjs';

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
