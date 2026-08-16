import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

export const CODEX_MAIN_DOCUMENT_URL = 'app://-/index.html';

let cdpHttpAgent = null;
let cdpHttpClientClosed = false;

function transportEvent(type, data) {
  if (type === 'message') return new MessageEvent(type, { data });
  return new Event(type);
}

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WEBSOCKET_MESSAGE_BYTES = 16_000_000;

function loopbackHostname(value) {
  const hostname = String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost') return '127.0.0.1';
  return ['127.0.0.1', '::1'].includes(hostname) ? hostname : '';
}

function maskedWebSocketFrame(opcode, value = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let lengthBytes = 0;
  if (payload.length >= 126 && payload.length <= 65_535) lengthBytes = 2;
  else if (payload.length > 65_535) lengthBytes = 8;
  const header = Buffer.allocUnsafe(2 + lengthBytes + 4);
  header[0] = 0x80 | (opcode & 0x0f);
  if (lengthBytes === 0) header[1] = 0x80 | payload.length;
  else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskOffset = 2 + lengthBytes;
  const mask = crypto.randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, masked]);
}

class LoopbackWebSocketTransport extends EventTarget {
  constructor(value) {
    super();
    const url = new URL(String(value || ''));
    const hostname = loopbackHostname(url.hostname);
    if (url.protocol !== 'ws:' || !hostname || url.username || url.password) {
      throw new Error('Codex 调试 WebSocket 地址不在本机允许列表中');
    }
    const port = Number(url.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Codex 调试 WebSocket 端口无效');
    this.closed = false;
    this.opened = false;
    this.socketClosed = false;
    this.terminationPromise = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.fragmentBuffers = [];
    this.fragmentSize = 0;
    this.fragmentOpcode = 0;
    this.handshakeKey = crypto.randomBytes(16).toString('base64');
    this.expectedAccept = crypto.createHash('sha1').update(this.handshakeKey + WEBSOCKET_GUID).digest('base64');
    this.url = url;
    this.socket = net.createConnection({ host: hostname, port });
    this.socket.setNoDelay(true);
    this.socket.once('connect', () => this.#writeHandshake());
    this.socket.on('data', chunk => this.#handleData(chunk));
    this.socket.once('error', () => this.#fail());
    this.socket.once('close', () => {
      this.socketClosed = true;
      this.closed = true;
      this.#dispatchClose();
    });
  }

  waitForOpen(timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('open', opened);
        this.removeEventListener('error', failed);
        this.removeEventListener('close', closed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('无法连接 Codex 调试接口')); };
      const closed = () => { cleanup(); reject(new Error('Codex 调试连接在握手期间关闭')); };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('连接 Codex 调试接口超时'));
      }, timeoutMs);
      this.addEventListener('open', opened, { once: true });
      this.addEventListener('error', failed, { once: true });
      this.addEventListener('close', closed, { once: true });
    });
  }

  send(data) {
    if (this.closed || !this.opened) throw new Error('Codex 调试连接不可用');
    const payload = Buffer.from(String(data), 'utf8');
    if (payload.length > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error('Codex 调试消息过大');
    this.socket.write(maskedWebSocketFrame(0x1, payload));
  }

  close() {
    void this.terminate();
  }

  async terminate() {
    if (this.terminationPromise) return this.terminationPromise;
    this.closed = true;
    this.#dispatchClose();
    this.terminationPromise = new Promise(resolve => {
      if (this.socketClosed) {
        resolve();
        return;
      }
      this.socket.once('close', resolve);
      this.socket.destroy();
    });
    await this.terminationPromise;
  }

  #writeHandshake() {
    if (this.closed) return;
    const requestTarget = `${this.url.pathname || '/'}${this.url.search}`;
    this.socket.write([
      `GET ${requestTarget} HTTP/1.1`,
      `Host: ${this.url.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  }

  #handleData(chunk) {
    if (this.closed) return;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    if (!this.opened) {
      const boundary = this.receiveBuffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (this.receiveBuffer.length > 65_536) this.#fail();
        return;
      }
      const header = this.receiveBuffer.subarray(0, boundary).toString('latin1');
      this.receiveBuffer = this.receiveBuffer.subarray(boundary + 4);
      const lines = header.split('\r\n');
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
      }
      if (
        !/^HTTP\/1\.[01] 101\b/.test(lines[0] || '')
        || String(headers.get('upgrade') || '').toLowerCase() !== 'websocket'
        || !String(headers.get('connection') || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')
        || headers.get('sec-websocket-accept') !== this.expectedAccept
      ) {
        this.#fail();
        return;
      }
      this.opened = true;
      this.dispatchEvent(transportEvent('open'));
    }
    this.#readFrames();
  }

  #readFrames() {
    while (!this.closed && this.receiveBuffer.length >= 2) {
      const first = this.receiveBuffer[0];
      const second = this.receiveBuffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      if (first & 0x70) {
        this.#fail();
        return;
      }
      const masked = Boolean(second & 0x80);
      if (masked) {
        this.#fail();
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.receiveBuffer.length < 4) return;
        length = this.receiveBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.receiveBuffer.length < 10) return;
        const largeLength = this.receiveBuffer.readBigUInt64BE(2);
        if (largeLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
          this.#fail();
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }
      if (length > MAX_WEBSOCKET_MESSAGE_BYTES || (!fin && opcode >= 0x8) || (opcode >= 0x8 && length > 125)) {
        this.#fail();
        return;
      }
      if (this.receiveBuffer.length < offset + length) return;
      const payload = Buffer.from(this.receiveBuffer.subarray(offset, offset + length));
      this.receiveBuffer = this.receiveBuffer.subarray(offset + length);
      if (opcode === 0x8) {
        void this.terminate();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(maskedWebSocketFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) {
        if (this.fragmentOpcode) {
          this.#fail();
          return;
        }
        if (fin) {
          this.dispatchEvent(transportEvent('message', payload.toString('utf8')));
          continue;
        }
        this.fragmentOpcode = opcode;
        this.fragmentBuffers = [payload];
        this.fragmentSize = payload.length;
        continue;
      }
      if (opcode === 0x0 && this.fragmentOpcode === 0x1) {
        this.fragmentBuffers.push(payload);
        this.fragmentSize += payload.length;
        if (this.fragmentSize > MAX_WEBSOCKET_MESSAGE_BYTES) {
          this.#fail();
          return;
        }
        if (fin) {
          const message = Buffer.concat(this.fragmentBuffers, this.fragmentSize).toString('utf8');
          this.fragmentOpcode = 0;
          this.fragmentBuffers = [];
          this.fragmentSize = 0;
          this.dispatchEvent(transportEvent('message', message));
        }
        continue;
      }
      this.#fail();
      return;
    }
  }

  #fail() {
    if (this.closed) return;
    this.dispatchEvent(transportEvent('error'));
    void this.terminate();
  }

  #dispatchClose() {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.dispatchEvent(transportEvent('close'));
  }
}

function getCdpHttpAgent() {
  if (cdpHttpClientClosed) throw new Error('Codex 调试 HTTP 客户端已关闭');
  if (!cdpHttpAgent) {
    cdpHttpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1_000,
      maxSockets: 1,
      maxFreeSockets: 1,
      maxTotalSockets: 1,
    });
  }
  return cdpHttpAgent;
}

export function closeCdpHttpClient() {
  cdpHttpClientClosed = true;
  cdpHttpAgent?.destroy();
  cdpHttpAgent = null;
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closeListeners = new Set();
    this.closed = false;
    socket.addEventListener('message', event => this.#handleMessage(event));
    socket.addEventListener('close', () => this.#handleClose(new Error('Codex 调试连接已关闭')));
    socket.addEventListener('error', () => this.#handleClose(new Error('Codex 调试连接出错')));
  }

  static async connect(url, timeoutMs = 3_000) {
    const socket = new LoopbackWebSocketTransport(url);
    try {
      await socket.waitForOpen(timeoutMs);
    } catch (error) {
      await socket.terminate();
      throw error;
    }
    return new CdpClient(socket);
  }

  call(method, params = {}, timeoutMs = 5_000) {
    if (this.closed) return Promise.reject(new Error('Codex 调试连接不可用'));
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 调试调用超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.off(method, listener);
  }

  off(method, listener) {
    const listeners = this.listeners.get(method);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(method);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
  }

  offClose(listener) {
    this.closeListeners.delete(listener);
  }

  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response?.exceptionDetails) throw new Error('Codex 页面脚本执行失败');
    return response?.result?.value;
  }

  close() {
    if (!this.closed) this.socket.close();
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) || []) {
        try { listener(message.params || {}); } catch {}
      }
    }
    if (!message.id || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    message.error ? pending.reject(new Error(message.error.message || 'CDP error')) : pending.resolve(message.result);
  }

  #handleClose(error) {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) {
      try { listener(error); } catch {}
    }
    this.closeListeners.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

export function isCodexTargetCandidate(target) {
  return target?.type === 'page' && String(target.url || '') === CODEX_MAIN_DOCUMENT_URL;
}

function readJson(port, pathname, hostname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname,
      port,
      path: pathname,
      agent: getCdpHttpAgent(),
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2_000_000) {
          request.destroy(new Error('Codex 调试接口响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Codex 调试接口返回 HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Codex 调试接口返回无效 JSON')); }
      });
    });
    request.setTimeout(1_500, () => request.destroy(new Error('连接 Codex 调试接口超时')));
    request.on('error', reject);
  });
}

export async function listCdpTargets(port) {
  const expectedPort = Number(port);
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65_535) {
    throw new Error('Codex 调试接口端口无效');
  }
  let targets;
  try {
    targets = await readJson(port, '/json/list', '127.0.0.1');
  } catch {
    targets = await readJson(port, '/json/list', '::1');
  }
  if (!Array.isArray(targets)) throw new Error('Codex 调试接口目标列表无效');
  for (const target of targets) {
    if (!target?.webSocketDebuggerUrl) continue;
    let url;
    try { url = new URL(String(target.webSocketDebuggerUrl)); }
    catch { throw new Error('Codex 调试目标 WebSocket 地址无效'); }
    const targetPort = Number(url.port || 80);
    if (
      url.protocol !== 'ws:'
      || !loopbackHostname(url.hostname)
      || url.username
      || url.password
      || url.hash
      || targetPort !== expectedPort
    ) {
      throw new Error('Codex 调试目标 WebSocket 不属于当前本机端口');
    }
  }
  return targets;
}

export async function listCodexTargets(port) {
  const targets = await listCdpTargets(port);
  return targets.filter(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl);
}
