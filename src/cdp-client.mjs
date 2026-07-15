import http from 'node:http';

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
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Codex 调试接口超时')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('无法连接 Codex 调试接口'));
      }, { once: true });
    });
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
      this.socket.send(JSON.stringify({ id, method, params }));
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

function codexAppTargetUrl(target) {
  if (target?.type !== 'page') return false;
  const rawUrl = String(target.url || '');
  if (!rawUrl.toLowerCase().startsWith('app://')) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'app:' || url.hostname !== '-' || url.pathname !== '/index.html') return null;
    return url;
  } catch {
    return null;
  }
}

export function isCodexTargetCandidate(target) {
  const url = codexAppTargetUrl(target);
  return Boolean(url && url.search === '' && url.hash === '');
}

function readJson(port, pathname, hostname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname,
      port,
      path: pathname,
      agent: false,
      headers: { connection: 'close' },
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
  let targets;
  try {
    targets = await readJson(port, '/json/list', '127.0.0.1');
  } catch {
    targets = await readJson(port, '/json/list', '::1');
  }
  if (!Array.isArray(targets)) throw new Error('Codex 调试接口目标列表无效');
  return targets;
}

export async function listCodexTargets(port) {
  const targets = await listCdpTargets(port);
  return targets.filter(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl);
}

export function hasAuxiliaryPageTargets(targets) {
  return (targets || []).some(target => {
    const type = String(target?.type || '').toLowerCase();
    return ['page', 'webview', 'iframe'].includes(type) && !isCodexTargetCandidate(target);
  });
}
