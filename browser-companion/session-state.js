export const SESSION_ORIGINS = Object.freeze([
  'https://agentrouter.org',
  'https://anyrouter.top',
  'https://chatgpt.com',
]);

const SESSION_ORIGIN_SET = new Set(SESSION_ORIGINS);
const DEFAULT_STORAGE_KEY = 'validatedSessionOrigins';
const DEFAULT_IDENTITY_STORAGE_KEY = 'sessionUserIds';
export const MAX_BROWSER_RESPONSE_BYTES = 2_000_000;

export async function readLimitedResponseText(response, maximumBytes = MAX_BROWSER_RESPONSE_BYTES) {
  const limit = Math.max(1, Math.trunc(Number(maximumBytes) || MAX_BROWSER_RESPONSE_BYTES));
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error('第三方网站响应过大');

  if (!response?.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error('第三方网站响应过大');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let receivedBytes = 0;
  let cancelled = false;
  const cancel = reason => {
    if (cancelled) return;
    cancelled = true;
    try { reader.cancel(reason)?.catch?.(() => {}); } catch {}
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > limit) {
        const error = new Error('第三方网站响应过大');
        cancel(error);
        throw error;
      }
      chunks.push(decoder.decode(bytes, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function normalizeSessionOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && SESSION_ORIGIN_SET.has(url.origin) ? url.origin : '';
  } catch {
    return '';
  }
}

export function normalizeSessionOrigins(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeSessionOrigin).filter(Boolean))];
}

function hasCanonicalSessionOrigins(value, normalized) {
  if (value === undefined) return normalized.length === 0;
  return Array.isArray(value)
    && value.length === normalized.length
    && value.every((origin, index) => origin === normalized[index]);
}

export function browserJobTimeout(request = {}) {
  const requested = Number(request.waitMs);
  return Math.max(5_000, Math.min(35_000, Number.isFinite(requested) && requested > 0 ? requested : 30_000));
}

export class TrailingSingleFlight {
  constructor(operation, delayMs = 350) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    this.operation = operation;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.inFlight = null;
    this.timer = null;
    this.pending = false;
    this.pendingArguments = [];
    this.queuedImmediate = null;
  }

  runNow(...args) {
    if (this.inFlight) {
      this.#cancelPending();
      if (!this.queuedImmediate) {
        let resolve;
        let reject;
        const promise = new Promise((onFulfilled, onRejected) => {
          resolve = onFulfilled;
          reject = onRejected;
        });
        this.queuedImmediate = { args, promise, resolve, reject };
      } else {
        this.queuedImmediate.args = args;
      }
      return this.queuedImmediate.promise;
    }
    this.#cancelPending();
    return this.#start(args);
  }

  schedule(...args) {
    if (this.queuedImmediate) return;
    this.pending = true;
    this.pendingArguments = args;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#flush();
    }, this.delayMs);
  }

  #start(args) {
    const operation = Promise.resolve().then(() => this.operation(...args));
    this.inFlight = operation;
    operation.then(
      () => this.#settled(operation),
      () => this.#settled(operation),
    );
    return operation;
  }

  #settled(operation) {
    if (this.inFlight !== operation) return;
    this.inFlight = null;
    if (this.queuedImmediate) {
      const queued = this.queuedImmediate;
      this.queuedImmediate = null;
      this.#start(queued.args).then(queued.resolve, queued.reject);
      return;
    }
    if (this.pending && this.timer === null) this.#flush();
  }

  #flush() {
    if (!this.pending || this.inFlight) return;
    const args = this.pendingArguments;
    this.pending = false;
    this.pendingArguments = [];
    this.#start(args).catch(() => {});
  }

  #cancelPending() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    this.pendingArguments = [];
  }
}

export function selectReadySessionTab(tabs) {
  const candidates = (Array.isArray(tabs) ? tabs : []).filter(tab => (
    tab?.id != null
    && tab.status === 'complete'
    && tab.discarded !== true
    && tab.frozen !== true
  ));
  return candidates.sort((left, right) => (
    Number(right.active === true) - Number(left.active === true)
    || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0)
  ))[0] || null;
}

function normalizeSessionUserId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value ?? '').trim();
  if (!/^\d{1,32}$/.test(text)) return '';
  return text.replace(/^0+(?=\d)/, '');
}

function normalizeSessionUserIds(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const origin of SESSION_ORIGINS) {
    const userId = normalizeSessionUserId(source[origin]);
    if (userId) result[origin] = userId;
  }
  return result;
}

function hasCanonicalSessionUserIds(value, normalized) {
  if (value === undefined) return Object.keys(normalized).length === 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const normalizedKeys = Object.keys(normalized);
  return keys.length === normalizedKeys.length
    && keys.every(origin => typeof value[origin] === 'string' && value[origin] === normalized[origin]);
}

export class SessionHintStore {
  constructor(storage, key = DEFAULT_STORAGE_KEY) {
    this.storage = storage;
    this.key = key;
    this.updateChain = Promise.resolve();
  }

  async list() {
    const stored = await this.storage.get([this.key]);
    return normalizeSessionOrigins(stored?.[this.key]);
  }

  remember(origin) {
    const normalized = normalizeSessionOrigin(origin);
    if (!normalized) return this.list();
    return this.#update(current => [...current, normalized]);
  }

  forget(origin) {
    const normalized = normalizeSessionOrigin(origin);
    if (!normalized) return this.list();
    return this.#update(current => current.filter(value => value !== normalized));
  }

  async has(origin) {
    const normalized = normalizeSessionOrigin(origin);
    return Boolean(normalized) && (await this.list()).includes(normalized);
  }

  #update(transform) {
    this.updateChain = this.updateChain.catch(() => {}).then(async () => {
      const stored = await this.storage.get([this.key]);
      const raw = stored?.[this.key];
      const current = normalizeSessionOrigins(raw);
      const next = normalizeSessionOrigins(transform(current));
      const unchanged = current.length === next.length && current.every((value, index) => value === next[index]);
      if (unchanged && hasCanonicalSessionOrigins(raw, current)) return current;
      await this.storage.set({ [this.key]: next });
      return next;
    });
    return this.updateChain;
  }
}

export class SessionIdentityStore {
  constructor(storage, key = DEFAULT_IDENTITY_STORAGE_KEY) {
    this.storage = storage;
    this.key = key;
    this.updateChain = Promise.resolve();
  }

  async get(origin) {
    const normalized = normalizeSessionOrigin(origin);
    if (!normalized) return '';
    const stored = await this.storage.get([this.key]);
    return normalizeSessionUserIds(stored?.[this.key])[normalized] || '';
  }

  remember(origin, userId) {
    const normalized = normalizeSessionOrigin(origin);
    const normalizedUserId = normalizeSessionUserId(userId);
    if (!normalized || !normalizedUserId) return this.get(normalized);
    return this.#update(current => ({ ...current, [normalized]: normalizedUserId }));
  }

  forget(origin) {
    const normalized = normalizeSessionOrigin(origin);
    if (!normalized) return Promise.resolve({});
    return this.#update(current => {
      const next = { ...current };
      delete next[normalized];
      return next;
    });
  }

  #update(transform) {
    this.updateChain = this.updateChain.catch(() => {}).then(async () => {
      const stored = await this.storage.get([this.key]);
      const raw = stored?.[this.key];
      const current = normalizeSessionUserIds(raw);
      const next = normalizeSessionUserIds(transform(current));
      const unchanged = SESSION_ORIGINS.every(origin => current[origin] === next[origin]);
      if (unchanged && hasCanonicalSessionUserIds(raw, current)) return current;
      await this.storage.set({ [this.key]: next });
      return next;
    });
    return this.updateChain;
  }
}

export function browserSessionOutcome(request = {}, result = {}) {
  const origin = normalizeSessionOrigin(request.baseUrl || request.origin);
  if (!origin || !request.userHeader) return null;
  if (result?.loginRequired) return 'invalid';

  const status = Number(result?.status) || 0;
  let payload;
  try {
    payload = JSON.parse(String(result?.text || '').trim());
  } catch {
    return null;
  }
  if (status === 401) return 'invalid';
  if (status < 200 || status >= 500) return null;
  if (status < 400 && payload?.success === true && payload.data && typeof payload.data === 'object') return 'valid';
  const message = String(payload?.message || payload?.error || '');
  if (payload?.success === false && /(?:未登录|请.{0,8}登录|登录.{0,8}(?:失效|过期)|not\s+(?:logged|signed)\s+in|unauthori[sz]ed|authentication\s+required|login\s+required|invalid\s+session)/i.test(message)) {
    return 'invalid';
  }
  return null;
}

export function browserSessionUserId(request = {}, result = {}) {
  const origin = normalizeSessionOrigin(request.baseUrl || request.origin);
  if (!origin || String(request.userHeader || '').toLowerCase() !== 'new-api-user') return '';
  const status = Number(result?.status) || 0;
  if (status < 200 || status >= 300) return '';
  try {
    const payload = JSON.parse(String(result?.text || '').trim());
    if (payload?.success !== true || !payload.data || typeof payload.data !== 'object') return '';
    return normalizeSessionUserId(payload.data.id);
  } catch {
    return '';
  }
}
