import {
  BROWSER_JOB_TIMEOUT_MS,
  BROWSER_LOGIN_JOB_TIMEOUT_MS,
} from './protocol.js';

export const SESSION_ORIGINS = Object.freeze([
  'https://agentrouter.org',
  'https://anyrouter.top',
  'https://chatgpt.com',
  'https://free.lyclaude.site',
  'https://jianzhile.vip',
  'https://muyuan.do',
  'https://welfare.0xpsyche.me',
]);

const DEFAULT_STORAGE_KEY = 'validatedSessionOrigins';
const DEFAULT_IDENTITY_STORAGE_KEY = 'sessionUserIds';
const MAX_SESSION_ORIGINS = 64;
export const MAX_BROWSER_RESPONSE_BYTES = 2_000_000;

export function browserResponseMetadata(status, contentType, cfMitigated) {
  const normalizedStatus = Number(status) || 0;
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  const normalizedCfMitigated = String(cfMitigated || '').trim().toLowerCase();
  const isJson = /(?:^|\/)json(?:;|$)/.test(normalizedContentType)
    || /\+json(?:;|$)/.test(normalizedContentType);
  const cfChallenge = normalizedCfMitigated === 'challenge'
    || normalizedCfMitigated.includes('challenge');
  const interactivePage = cfChallenge
    || /(?:text\/html|application\/xhtml\+xml)/.test(normalizedContentType)
    || (normalizedStatus === 403 && !normalizedContentType);
  return {
    contentType: normalizedContentType,
    cfMitigated: cfChallenge,
    interactivePage: interactivePage && !isJson,
  };
}

export async function readLimitedResponseText(
  response,
  maximumBytes = MAX_BROWSER_RESPONSE_BYTES,
  oversizedMessage = '第三方网站响应过大',
) {
  const limit = Math.max(1, Math.trunc(Number(maximumBytes) || MAX_BROWSER_RESPONSE_BYTES));
  const contentLengthHeader = response?.headers?.get?.('content-length');
  const contentLength = contentLengthHeader == null || String(contentLengthHeader).trim() === ''
    ? null
    : Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error(oversizedMessage);

  if (!response?.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error(oversizedMessage);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
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
        const error = new Error(oversizedMessage);
        cancel(error);
        throw error;
      }
      text += decoder.decode(bytes, { stream: true });
      const trimmedText = text.trim();
      if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
        try {
          JSON.parse(trimmedText);
          cancel('response complete');
          return text;
        } catch {}
      }
    }
    text += decoder.decode();
    return text;
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
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return '';
    return url.origin.length <= 512 ? url.origin : '';
  } catch {
    return '';
  }
}

export function normalizeSessionOrigins(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeSessionOrigin).filter(Boolean))]
    .slice(0, MAX_SESSION_ORIGINS);
}

function hasCanonicalSessionOrigins(value, normalized) {
  if (value === undefined) return normalized.length === 0;
  return Array.isArray(value)
    && value.length === normalized.length
    && value.every((origin, index) => origin === normalized[index]);
}

export function browserJobTimeout(job = {}) {
  return job.type === 'open-login' ? BROWSER_LOGIN_JOB_TIMEOUT_MS : BROWSER_JOB_TIMEOUT_MS;
}

export function companionPollFailurePolicy(failureCount, random = Math.random) {
  const failures = Math.max(1, Math.trunc(Number(failureCount) || 1));
  if (failures >= 3) return { failures, stop: true, delayMs: 0 };
  const baseDelayMs = Math.min(30_000, 2_000 * (2 ** (failures - 1)));
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitter = 0.8 + randomValue * 0.4;
  return { failures, stop: false, delayMs: Math.round(baseDelayMs * jitter) };
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
  for (const [rawOrigin, rawUserId] of Object.entries(source)) {
    const origin = normalizeSessionOrigin(rawOrigin);
    const userId = normalizeSessionUserId(rawUserId);
    if (origin && userId && !(origin in result)) result[origin] = userId;
    if (Object.keys(result).length >= MAX_SESSION_ORIGINS) break;
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
    this.cache = null;
    this.readPromise = null;
    this.generation = 0;
  }

  async list() {
    return [...(await this.#readSnapshot()).value];
  }

  invalidate() {
    this.generation += 1;
    this.cache = null;
    this.readPromise = null;
  }

  replace(origins) {
    return this.#update(() => origins);
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
      const snapshot = await this.#readSnapshot();
      const current = snapshot.value;
      const next = normalizeSessionOrigins(transform(current));
      const unchanged = current.length === next.length && current.every((value, index) => value === next[index]);
      if (unchanged && snapshot.canonical) return [...current];
      const generation = this.generation;
      await this.storage.set({ [this.key]: next });
      if (generation === this.generation) this.cache = { value: next, canonical: true };
      return [...next];
    });
    return this.updateChain;
  }

  async #readSnapshot() {
    if (this.cache) return this.cache;
    if (this.readPromise) return this.readPromise;
    const generation = this.generation;
    const operation = this.storage.get([this.key]).then(stored => {
      const raw = stored?.[this.key];
      const value = normalizeSessionOrigins(raw);
      const snapshot = {
        value,
        canonical: hasCanonicalSessionOrigins(raw, value),
      };
      if (generation === this.generation) this.cache = snapshot;
      return snapshot;
    });
    this.readPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.readPromise === operation) this.readPromise = null;
    }
  }
}

export class SessionIdentityStore {
  constructor(storage, key = DEFAULT_IDENTITY_STORAGE_KEY) {
    this.storage = storage;
    this.key = key;
    this.updateChain = Promise.resolve();
    this.cache = null;
    this.readPromise = null;
    this.generation = 0;
  }

  async get(origin) {
    const normalized = normalizeSessionOrigin(origin);
    if (!normalized) return '';
    return (await this.#readSnapshot()).value[normalized] || '';
  }

  invalidate() {
    this.generation += 1;
    this.cache = null;
    this.readPromise = null;
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
      const snapshot = await this.#readSnapshot();
      const current = snapshot.value;
      const next = normalizeSessionUserIds(transform(current));
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged = currentKeys.length === nextKeys.length
        && currentKeys.every(origin => current[origin] === next[origin]);
      if (unchanged && snapshot.canonical) return { ...current };
      const generation = this.generation;
      await this.storage.set({ [this.key]: next });
      if (generation === this.generation) this.cache = { value: next, canonical: true };
      return { ...next };
    });
    return this.updateChain;
  }

  async #readSnapshot() {
    if (this.cache) return this.cache;
    if (this.readPromise) return this.readPromise;
    const generation = this.generation;
    const operation = this.storage.get([this.key]).then(stored => {
      const raw = stored?.[this.key];
      const value = normalizeSessionUserIds(raw);
      const snapshot = { value, canonical: hasCanonicalSessionUserIds(raw, value) };
      if (generation === this.generation) this.cache = snapshot;
      return snapshot;
    });
    this.readPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.readPromise === operation) this.readPromise = null;
    }
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
