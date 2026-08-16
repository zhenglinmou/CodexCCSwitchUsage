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
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.origin : '';
  } catch {
    return '';
  }
}

const ALLOWED_BROWSER_HEADERS = new Map([
  ['accept', 'Accept'],
  ['authorization', 'Authorization'],
  ['chatgpt-account-id', 'ChatGPT-Account-Id'],
  ['new-api-user', 'New-Api-User'],
]);

function normalizeBrowserHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = ALLOWED_BROWSER_HEADERS.get(String(rawName || '').trim().toLowerCase());
    const headerValue = String(rawValue ?? '');
    if (!name) throw new Error(`浏览器任务包含不允许的请求头: ${String(rawName || '').slice(0, 80)}`);
    if (!headerValue || headerValue.length > 16_384 || /[\r\n\0]/.test(headerValue)) {
      throw new Error(`浏览器任务请求头无效: ${name}`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function normalizeBrowserJobRequest(type, request = {}) {
  const jobType = String(type || '');
  if (!['query-json', 'open-login'].includes(jobType)) throw new Error('浏览器任务类型无效');
  const origin = normalizeOrigin(request.baseUrl || request.loginUrl || request.origin);
  if (!origin) throw new Error('浏览器任务必须使用有效的 HTTPS Origin');
  let requestPath = String(request.requestPath || '/').trim();
  if (!requestPath.startsWith('/') || requestPath.length > 2_048 || /[\r\n\0]/.test(requestPath)) {
    throw new Error('浏览器任务请求路径无效');
  }
  const requestUrl = new URL(requestPath, origin);
  if (requestUrl.origin !== origin || requestUrl.username || requestUrl.password || requestUrl.hash) {
    throw new Error('浏览器任务请求必须保持 HTTPS 同源');
  }
  requestPath = `${requestUrl.pathname}${requestUrl.search}`;
  let loginUrl = '';
  if (request.loginUrl) {
    const candidate = new URL(String(request.loginUrl));
    if (candidate.protocol !== 'https:' || candidate.origin !== origin || candidate.username || candidate.password || candidate.hash) {
      throw new Error('浏览器任务登录地址必须保持 HTTPS 同源');
    }
    loginUrl = candidate.href;
  }
  const userHeader = String(request.userHeader || '').trim();
  if (userHeader && userHeader.toLowerCase() !== 'new-api-user') throw new Error('浏览器任务用户标识请求头无效');
  return {
    baseUrl: origin,
    requestPath,
    headers: normalizeBrowserHeaders(request.headers),
    ...(loginUrl ? { loginUrl } : {}),
    ...(userHeader ? { userHeader: 'New-Api-User' } : {}),
    navigateRequest: request.navigateRequest === true,
    origin,
  };
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

function cleanClaimToken(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(text) ? text : '';
}

function equalClaimToken(left, right) {
  const first = Buffer.from(cleanClaimToken(left));
  const second = Buffer.from(cleanClaimToken(right));
  return first.length > 0 && first.length === second.length && crypto.timingSafeEqual(first, second);
}

export class BrowserCallbackBroker {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.connectionMaxAgeMs = Math.max(10_000, Number(options.connectionMaxAgeMs) || 45_000);
    this.queryTimeoutMs = Math.max(10_000, Number(options.queryTimeoutMs) || BROWSER_CALLBACK_TIMEOUT_MS);
    this.preferredClientGraceMs = Math.max(1_000, Number(options.preferredClientGraceMs) || 5_000);
    this.maxClients = Math.max(1, Math.min(128, Number(options.maxClients) || 32));
    this.maxSessionsPerClient = Math.max(1, Math.min(256, Number(options.maxSessionsPerClient) || 64));
    this.maxWaiters = Math.max(1, Math.min(256, Number(options.maxWaiters) || 64));
    this.maxPendingJobs = Math.max(1, Math.min(512, Number(options.maxPendingJobs) || 128));
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
    this.#pruneClients();
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
    const existingClient = this.clients.get(key);
    if (!existingClient && this.clients.size >= this.maxClients) {
      throw new Error('浏览器伴侣连接数量已达到上限');
    }
    const existing = existingClient || { sessions: new Set() };
    const instanceId = cleanInstanceId(payload.instanceId) || existing.instanceId || '';
    if (instanceId && existing.instanceId !== instanceId) {
      this.generation += 1;
      if (existing.instanceId) {
        this.#requeueClaimedJobs(key, existing.instanceId);
        this.#cancelWaiters(key);
      }
    }
    const sessions = Array.isArray(payload.sessions)
      ? new Set(payload.sessions.slice(0, this.maxSessionsPerClient).map(normalizeOrigin).filter(Boolean))
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
    this.#pruneClients();
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
      if (!client.sessions.has(normalized) && client.sessions.size >= this.maxSessionsPerClient) continue;
      client.sessions.add(normalized);
      client.lastSeenAt = this.now();
      this.clients.set(key, client);
      accepted = true;
    }
    return accepted;
  }

  getStatus() {
    this.#pruneClients();
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
    this.#pruneClients();
    const cutoff = this.now() - this.connectionMaxAgeMs;
    for (const client of this.clients.values()) {
      if (client.lastSeenAt >= cutoff) return true;
    }
    return false;
  }

  listQueryClients(origin = '') {
    this.#pruneClients();
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
    this.#pruneClients();
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
    if (this.waiters.length >= this.maxWaiters) throw new Error('浏览器伴侣等待连接数量已达到上限');
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

  complete(jobId, result, claimant = {}) {
    const key = String(jobId || '');
    const pending = this.pending.get(key);
    if (!pending) return false;
    const claimedClientKey = clientKey(cleanClientId(claimant.clientId), claimant.browser);
    const claimedInstanceId = cleanInstanceId(claimant.instanceId);
    if (
      !pending.claimedClientKey
      || claimedClientKey !== pending.claimedClientKey
      || claimedInstanceId !== pending.claimedInstanceId
      || !equalClaimToken(claimant.claimToken, pending.claimToken)
    ) return false;
    this.pending.delete(key);
    this.queue = this.queue.filter(job => job.publicJob.id !== key);
    clearTimeout(pending.timer);
    this.#schedulePreferenceRelease();
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
    if (this.pending.size >= this.maxPendingJobs) return Promise.reject(new Error('浏览器余额任务数量已达到上限'));
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('浏览器余额回调已取消'));
    let safeRequest;
    try {
      safeRequest = normalizeBrowserJobRequest(type, request);
    } catch (error) {
      return Promise.reject(error);
    }
    const origin = safeRequest.origin;
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
      request: safeRequest,
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
        job: null,
        claimedClientKey: '',
        claimedInstanceId: '',
        claimToken: '',
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
      pending.job = job;
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
    const job = this.queue.splice(index, 1)[0];
    const pending = this.pending.get(job.publicJob.id);
    if (pending) {
      pending.claimedClientKey = key;
      pending.claimedInstanceId = this.clients.get(key)?.instanceId || '';
      pending.claimToken = crypto.randomBytes(24).toString('base64url');
    }
    return pending
      ? { ...job, publicJob: { ...job.publicJob, claimToken: pending.claimToken } }
      : job;
  }

  #requeueClaimedJobs(key, instanceId) {
    const queuedIds = new Set(this.queue.map(job => job.publicJob.id));
    for (const pending of this.pending.values()) {
      if (!pending.job
        || pending.claimedClientKey !== key
        || pending.claimedInstanceId !== instanceId
        || queuedIds.has(pending.job.publicJob.id)) continue;
      pending.claimedClientKey = '';
      pending.claimedInstanceId = '';
      pending.claimToken = '';
      pending.job.preferredClientKey = pending.job.targetClientKey || key;
      pending.job.preferredUntil = this.now() + this.preferredClientGraceMs;
      this.queue.push(pending.job);
      queuedIds.add(pending.job.publicJob.id);
    }
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

  #pruneClients() {
    if (this.closed || this.clients.size === 0) return 0;
    const cutoff = this.now() - this.connectionMaxAgeMs;
    let removed = 0;
    for (const [key, client] of this.clients) {
      if (client.lastSeenAt >= cutoff) continue;
      this.#requeueClaimedJobs(key, client.instanceId || '');
      this.#cancelWaiters(key);
      this.clients.delete(key);
      removed += 1;
    }
    if (removed > 0) this.#dispatch();
    return removed;
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
