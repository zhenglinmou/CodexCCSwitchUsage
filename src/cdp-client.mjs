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

function isCodexPageTarget(target) {
  if (target?.type !== 'page') return false;
  const url = String(target.url || '').toLowerCase();
  return url === '' || url === 'about:blank' || url.startsWith('app://');
}

export function isCodexAuxiliaryTarget(target) {
  if (!isCodexPageTarget(target)) return false;
  const rawUrl = String(target.url || '');
  if (!rawUrl.toLowerCase().startsWith('app://')) return false;
  try {
    const initialRoute = new URL(rawUrl).searchParams.get('initialRoute');
    return String(initialRoute || '').toLowerCase() === '/avatar-overlay';
  } catch {}
  return false;
}

export function isCodexTargetCandidate(target) {
  return isCodexPageTarget(target) && !isCodexAuxiliaryTarget(target);
}

export async function listCodexTargets(port, { includeAuxiliary = false } = {}) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_500) });
  } catch {
    response = await fetch(`http://[::1]:${port}/json/list`, { signal: AbortSignal.timeout(1_500) });
  }
  if (!response.ok) throw new Error(`Codex 调试接口返回 HTTP ${response.status}`);
  const targets = await response.json();
  return targets.filter(target => (
    (includeAuxiliary ? isCodexPageTarget(target) : isCodexTargetCandidate(target))
    && target.webSocketDebuggerUrl
  ));
}

export async function getBrowserWebSocketUrl(port) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) });
  } catch {
    response = await fetch(`http://[::1]:${port}/json/version`, { signal: AbortSignal.timeout(1_500) });
  }
  if (!response.ok) throw new Error(`Codex 浏览器调试接口返回 HTTP ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error('Codex 浏览器调试接口缺少 WebSocket 地址');
  return version.webSocketDebuggerUrl;
}
