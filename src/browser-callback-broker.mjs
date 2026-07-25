import crypto from 'node:crypto';
import {
  BROWSER_CALLBACK_TIMEOUT_MS,
  BROWSER_LOGIN_JOB_TIMEOUT_MS,
  COMPANION_CAPABILITIES,
  COMPANION_PROTOCOL_VERSION,
  companionCompatibility,
} from '../browser-companion/protocol.js';

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

function cleanClientId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(text) ? text : '';
}

function cleanInstanceId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(text) ? text : '';
}

function normalizeBrowser(value) {
  const text = String(value || '').trim();
  if (/^edge$/i.test(text)) return 'Edge';
  if (/^chrome$/i.test(text)) return 'Chrome';
  if (/^chromium$/i.test(text)) return 'Chromium';
  return text.slice(0, 64) || 'Chromium';
}

function clientKey(clientId, browser) {
  return `${clientId}\0${normalizeBrowser(browser).toLocaleLowerCase('en-US')}`;
}

function clientRef(key) {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 16);
}

export class BrowserCallbackBroker {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.connectionMaxAgeMs = Math.max(10_000, Number(options.connectionMaxAgeMs) || 45_000);
    this.queryTimeoutMs = Math.max(10_000, Number(options.queryTimeoutMs) || BROWSER_CALLBACK_TIMEOUT_MS);
    this.preferredClientGraceMs = Math.max(1_000, Number(options.preferredClientGraceMs) || 5_000);
    this.clients = new Map();
    this.queue = [];
    this.waiters = [];
    this.pending = new Map();
    this.closed = false;
    this.generation = 0;
    this.preferenceTimer = null;
    this.lastCompatibilityError = '';
  }

  heartbeat(payload = {}) {
    const clientId = cleanClientId(payload.clientId);
    if (!clientId) throw new Error('浏览器伴侣 clientId 无效');
    const browser = normalizeBrowser(payload.browser);
    const key = clientKey(clientId, browser);
    const compatibility = companionCompatibility(payload);
    if (!compatibility.compatible) {
      this.#cancelWaiters(key);
      this.clients.delete(key);
      this.lastCompatibilityError = compatibility.message;
      throw new Error(compatibility.message);
    }
    this.lastCompatibilityError = '';
    const existing = this.clients.get(key) || { sessions: new Set() };
    const instanceId = cleanInstanceId(payload.instanceId) || existing.instanceId || '';
    if (instanceId && existing.instanceId !== instanceId) {
      this.generation += 1;
      if (existing.instanceId) this.#cancelWaiters(key);
    }
    const sessions = Array.isArray(payload.sessions)
      ? new Set(payload.sessions.map(normalizeOrigin).filter(Boolean))
      : new Set(existing.sessions);
    this.clients.set(key, {
      key,
      clientId,
      ref: clientRef(key),
      browser,
      version: String(payload.version || existing.version || '').slice(0, 32),
      instanceId,
      protocolVersion: compatibility.protocolVersion,
      capabilities: compatibility.capabilities,
      sessions,
      lastSeenAt: this.now(),
    });
    this.#dispatch();
    return this.getStatus();
  }

  noteSession(clientId, origin, browser = '') {
    const id = cleanClientId(clientId);
    const normalized = normalizeOrigin(origin);
    if (!id || !normalized) return false;
    const requestedBrowser = String(browser || '').trim();
    const matches = requestedBrowser
      ? [[clientKey(id, requestedBrowser), this.clients.get(clientKey(id, requestedBrowser))]]
      : [...this.clients.entries()].filter(([, client]) => client.clientId === id);
    let accepted = false;
    for (const [key, client] of matches) {
      if (!client) continue;
      client.sessions.add(normalized);
      client.lastSeenAt = this.now();
      this.clients.set(key, client);
      accepted = true;
    }
    return accepted;
  }

  getStatus() {
    const cutoff = this.now() - this.connectionMaxAgeMs;
    const active = [...this.clients.values()].filter(client => client.lastSeenAt >= cutoff);
    return {
      connected: active.length > 0,
      generation: this.generation,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requiredCapabilities: [...COMPANION_CAPABILITIES],
      compatibilityError: this.lastCompatibilityError,
      clients: active.map(client => ({
        ref: client.ref,
        browser: client.browser,
        version: client.version,
        protocolVersion: client.protocolVersion,
        capabilities: [...client.capabilities],
        sessions: [...client.sessions],
        lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      })),
      queuedJobs: this.queue.length,
      pendingJobs: this.pending.size,
    };
  }

  isConnected() {
    return this.getStatus().connected;
  }

  listQueryClients(origin = '') {
    const normalized = normalizeOrigin(origin);
    const cutoff = this.now() - this.connectionMaxAgeMs;
    return [...this.clients.values()]
      .filter(client => client.lastSeenAt >= cutoff)
      .map(client => ({
        clientId: client.clientId,
        clientRef: client.ref,
        browser: client.browser,
        hasSession: Boolean(normalized && client.sessions.has(normalized)),
      }))
      .sort((left, right) => Number(right.hasSession) - Number(left.hasSession));
  }

  hasSession(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    const cutoff = this.now() - this.connectionMaxAgeMs;
    return [...this.clients.values()].some(client => client.lastSeenAt >= cutoff && client.sessions.has(normalized));
  }

  async nextJob(payload = {}, waitMs = 25_000, options = {}) {
    if (this.closed) return null;
    const clientId = cleanClientId(payload.clientId);
    if (!clientId) throw new Error('浏览器伴侣 clientId 无效');
    const key = clientKey(clientId, payload.browser);
    const signal = options?.signal;
    if (signal?.aborted) return null;
    // A Chromium MV3 worker may restart while its previous long poll is still
    // waiting in Node. The newest poll for a stable client id owns delivery;
    // otherwise an abandoned response can claim and strand the next job.
    this.#cancelWaiters(key);
    this.heartbeat(payload);
    const queued = this.#takeJob(key);
    if (queued) {
      this.#schedulePreferenceRelease();
      return queued.publicJob;
    }
    return new Promise(resolve => {
      const waiter = {
        clientKey: key,
        clientId,
        instanceId: cleanInstanceId(payload.instanceId) || this.clients.get(key)?.instanceId || '',
        resolve: null,
        timer: null,
        settled: false,
      };
      const abort = () => waiter.resolve(null);
      waiter.resolve = value => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', abort);
        this.waiters = this.waiters.filter(item => item !== waiter);
        resolve(value);
      };
      waiter.timer = setTimeout(() => {
        waiter.resolve(null);
      }, Math.max(1_000, Math.min(30_000, Number(waitMs) || 25_000)));
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
      this.#dispatch();
    });
  }

  queryJson(request, options = {}) {
    return this.#enqueue('query-json', request, this.queryTimeoutMs, options);
  }

  queryJsonOnClient(selector, request, options = {}) {
    const targetClientKey = this.#resolveClientKey(selector);
    if (!targetClientKey) return Promise.reject(new Error('指定的浏览器余额伴侣未连接'));
    return this.#enqueue('query-json', request, this.queryTimeoutMs, { ...options, targetClientKey });
  }

  openLogin(request) {
    return this.#enqueue('open-login', request, BROWSER_LOGIN_JOB_TIMEOUT_MS);
  }

  openLoginOnClient(selector, request) {
    const targetClientKey = this.#resolveClientKey(selector);
    if (!targetClientKey) return Promise.reject(new Error('指定的浏览器余额伴侣未连接'));
    return this.#enqueue('open-login', request, BROWSER_LOGIN_JOB_TIMEOUT_MS, { targetClientKey });
  }

  complete(jobId, result) {
    const key = String(jobId || '');
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (result?.ok === false) {
      pending.reject(new Error(String(result.message || '浏览器伴侣执行失败')));
    } else {
      pending.resolve(result?.value ?? result ?? null);
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter.resolve(null);
    }
    this.waiters = [];
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('浏览器余额伴侣回调已关闭'));
    }
    this.pending.clear();
    this.queue = [];
    this.clients.clear();
    if (this.preferenceTimer) clearTimeout(this.preferenceTimer);
    this.preferenceTimer = null;
  }

  #enqueue(type, request, timeoutMs, options = {}) {
    if (this.closed) return Promise.reject(new Error('浏览器余额伴侣回调已关闭'));
    if (!this.isConnected()) return Promise.reject(new Error('现有浏览器余额伴侣未连接'));
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('浏览器余额回调已取消'));
    const origin = normalizeOrigin(request?.baseUrl || request?.loginUrl || request?.origin);
    const targetClientKey = String(options?.targetClientKey || '');
    if (targetClientKey && !this.#isActiveClientKey(targetClientKey)) {
      return Promise.reject(new Error('指定的浏览器余额伴侣未连接'));
    }
    const preferredClientKey = targetClientKey ? '' : this.#preferredClient(origin);
    const id = crypto.randomUUID();
    const createdAt = this.now();
    const publicJob = {
      id,
      type,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + timeoutMs).toISOString(),
      request: { ...request, origin },
    };
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const pending = {
        resolve(value) {
          cleanup();
          resolve(value);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
        timer: null,
      };
      const abort = () => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        this.queue = this.queue.filter(item => item.publicJob.id !== id);
        clearTimeout(pending.timer);
        this.#schedulePreferenceRelease();
        pending.reject(signal.reason || new Error('浏览器余额回调已取消'));
      };
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        this.queue = this.queue.filter(job => job.publicJob.id !== id);
        this.#schedulePreferenceRelease();
        pending.reject(new Error('等待现有浏览器余额回调超时'));
      }, timeoutMs);
      const job = {
        publicJob,
        targetClientKey,
        preferredClientKey,
        preferredUntil: preferredClientKey ? this.now() + this.preferredClientGraceMs : 0,
      };
      this.pending.set(id, pending);
      this.queue.push(job);
      signal?.addEventListener('abort', abort, { once: true });
      this.#dispatch();
    });
  }

  #preferredClient(origin) {
    if (!origin) return '';
    const cutoff = this.now() - this.connectionMaxAgeMs;
    return [...this.clients.values()].find(client => client.lastSeenAt >= cutoff && client.sessions.has(origin))?.key || '';
  }

  #resolveClientKey(selector) {
    const value = String(selector || '').trim();
    if (!value) return '';
    const cutoff = this.now() - this.connectionMaxAgeMs;
    const active = [...this.clients.entries()].filter(([, client]) => client.lastSeenAt >= cutoff);
    const referenced = active.find(([, client]) => client.ref === value);
    if (referenced) return referenced[0];
    const id = cleanClientId(value);
    if (!id) return '';
    const matchingIds = active.filter(([, client]) => client.clientId === id);
    return matchingIds.length === 1 ? matchingIds[0][0] : '';
  }

  #isActiveClientKey(key) {
    const client = this.clients.get(key);
    return Boolean(client && client.lastSeenAt >= this.now() - this.connectionMaxAgeMs);
  }

  #cancelWaiters(key) {
    for (const waiter of [...this.waiters]) {
      if (waiter.clientKey === key) waiter.resolve(null);
    }
  }

  #takeJob(key) {
    const index = this.queue.findIndex(job => (
      job.targetClientKey
        ? job.targetClientKey === key
        : !job.preferredClientKey || job.preferredClientKey === key
    ));
    if (index < 0) return null;
    return this.queue.splice(index, 1)[0];
  }

  #dispatch() {
    this.#releaseExpiredPreferences();
    for (const waiter of [...this.waiters]) {
      const job = this.#takeJob(waiter.clientKey);
      if (!job) continue;
      waiter.resolve(job.publicJob);
    }
    this.#schedulePreferenceRelease();
  }

  #releaseExpiredPreferences() {
    const now = this.now();
    for (const job of this.queue) {
      if (job.preferredClientKey && now >= job.preferredUntil) job.preferredClientKey = '';
    }
  }

  #schedulePreferenceRelease() {
    if (this.preferenceTimer) clearTimeout(this.preferenceTimer);
    this.preferenceTimer = null;
    if (this.closed) return;
    const now = this.now();
    const next = this.queue
      .filter(job => job.preferredClientKey && job.preferredUntil > now)
      .reduce((minimum, job) => Math.min(minimum, job.preferredUntil), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(next)) return;
    this.preferenceTimer = setTimeout(() => {
      this.preferenceTimer = null;
      this.#dispatch();
    }, Math.max(1, next - now));
    this.preferenceTimer.unref?.();
  }
}

export { normalizeOrigin as normalizeBrowserOrigin };
