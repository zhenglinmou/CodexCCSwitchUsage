export const SESSION_ORIGINS = Object.freeze([
  'https://agentrouter.org',
  'https://anyrouter.top',
  'https://chatgpt.com',
]);

const SESSION_ORIGIN_SET = new Set(SESSION_ORIGINS);
const DEFAULT_STORAGE_KEY = 'validatedSessionOrigins';
const DEFAULT_IDENTITY_STORAGE_KEY = 'sessionUserIds';

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

export function browserJobTimeout(request = {}) {
  const requested = Number(request.waitMs);
  return Math.max(5_000, Math.min(35_000, Number.isFinite(requested) && requested > 0 ? requested : 30_000));
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
      const current = await this.list();
      const next = normalizeSessionOrigins(transform(current));
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
      const current = normalizeSessionUserIds(stored?.[this.key]);
      const next = normalizeSessionUserIds(transform(current));
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
  if (status === 401 || status === 403) return 'invalid';
  if (status < 200 || status >= 500) return null;
  if (payload?.success === true && payload.data && typeof payload.data === 'object') return 'valid';
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
