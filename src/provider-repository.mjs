import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCodexHomeDir, getDefaultDatabasePath, getHomeDir } from './platform.mjs';

const MAX_CODEX_PROVIDERS = 512;
const MAX_PROVIDER_CONFIG_CHARS = 65_536;
const MAX_CREDENTIAL_MATCH_ROWS = 64;
const MAX_LIVE_STATE_BYTES = 65_536;
const MAX_SETTINGS_BYTES = 262_144;
const MAX_CODEX_AUTH_BYTES = 65_536;
const PROVIDER_SELECT_COLUMNS = `
  substr(id, 1, 160) AS id,
  substr(name, 1, 160) AS name,
  substr(website_url, 1, 2048) AS website_url,
  is_current,
  sort_index,
  category,
  CASE WHEN settings_config IS NULL OR length(settings_config) <= ${MAX_PROVIDER_CONFIG_CHARS} THEN settings_config ELSE '{}' END AS settings_config,
  CASE WHEN meta IS NULL OR length(meta) <= ${MAX_PROVIDER_CONFIG_CHARS} THEN meta ELSE '{}' END AS meta
`;

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function providerCredentialValues(settings) {
  const values = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === 'string'
        && item
        && /^(?:openai_api_key|anthropic_api_key|anthropic_auth_token)$/i.test(key)
      ) {
        values.push(item);
      } else if (item && typeof item === 'object') {
        visit(item, depth + 1);
      }
    }
  };
  visit(settings);
  return values;
}

export function findBaseUrl(configText = '') {
  const matches = [...String(configText).matchAll(/^\s*base_url\s*=\s*["']([^"']+)["']/gmi)];
  return matches.at(-1)?.[1]?.replace(/\/+$/, '') ?? '';
}

function currentOfficialRow(row) {
  return Boolean(row?.is_current && row.category === 'official');
}

export function parseProviderRow(row, codexAuthSnapshot = null) {
  if (!row) return null;
  const settings = parseJson(row.settings_config, {});
  const meta = parseJson(row.meta, {});
  const usage = meta?.usage_script;
  const storedAuth = settings?.auth && typeof settings.auth === 'object' ? settings.auth : {};
  const apiBaseUrl = findBaseUrl(settings?.config || '').trim().slice(0, 2_048);
  const apiKey = String(storedAuth.OPENAI_API_KEY || storedAuth.openai_api_key || '').slice(0, 16_384);
  // An unbound official card follows the active Codex login. Legacy auth
  // snapshots in the card do not authenticate the active official route.
  const followsCodexLogin = Boolean(codexAuthSnapshot && currentOfficialRow(row)
    && !apiKey && (!apiBaseUrl || /^https:\/\/chatgpt\.com(?:\/|$)/i.test(apiBaseUrl))
    && meta?.authBinding?.source !== 'managed_account');

  const id = String(row.id || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
  if (!id) return null;
  return {
    id,
    name: String(row.name || '当前供应商').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || '当前供应商',
    websiteUrl: String(row.website_url || '').trim().slice(0, 2_048),
    isCurrent: Boolean(row.is_current),
    sortIndex: row.sort_index != null && Number.isFinite(Number(row.sort_index)) ? Number(row.sort_index) : null,
    usage: usage && typeof usage === 'object' ? usage : null,
    auth: followsCodexLogin ? codexAuthSnapshot.auth : storedAuth,
    apiKey,
    ...(followsCodexLogin ? { followsCodexLogin: true } : {}),
    ...(row.is_proxy_route ? { isProxyRoute: true } : {}),
    apiBaseUrl,
    baseUrl: String(usage?.baseUrl || apiBaseUrl).trim().slice(0, 2_048).replace(/\/+$/, ''),
  };
}

function providerRowSignature(row) {
  if (!row) return 'null';
  return JSON.stringify([
    row.id,
    row.name,
    row.website_url,
    row.is_current,
    row.is_proxy_route,
    row.sort_index,
    row.category,
    row.settings_config,
    row.meta,
  ]);
}

function withCurrentProvider(row, selection) {
  if (!row || !selection) return row;
  const current = Number(row.id === selection.row.id);
  return { ...row, is_current: current, is_proxy_route: current && selection.isProxyRoute ? 1 : undefined };
}

function readBoundedJson(filename, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validProviderId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 160 && !/[\u0000-\u0020\u007f]/.test(id)
    ? id
    : null;
}

function readLiveProviderId(filename) {
  const state = readBoundedJson(filename, MAX_LIVE_STATE_BYTES);
  const codex = state?.apps?.codex;
  if (state?.version !== 1 || codex?.mode !== 'proxy' || codex.attached !== true) return null;
  return validProviderId(codex.proxy_route);
}

function readDeviceProviderId(filename) {
  return validProviderId(readBoundedJson(filename, MAX_SETTINGS_BYTES)?.currentProviderCodex);
}

function samePath(left, right) {
  const normalize = value => {
    const absolute = path.resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

function ccswitchFilePaths(requestedDatabase, env) {
  const defaultDatabase = getDefaultDatabasePath(env);
  const deviceDirectory = path.dirname(defaultDatabase);
  const home = getHomeDir(env);
  const appData = process.platform === 'win32' ? (env.APPDATA || (home && path.join(home, 'AppData', 'Roaming')))
    : process.platform === 'darwin' ? (home && path.join(home, 'Library', 'Application Support'))
      : (env.XDG_DATA_HOME || (home && path.join(home, '.local', 'share')));
  let configuredDatabase = defaultDatabase;
  if (appData && path.isAbsolute(appData)) {
    try {
      const storePath = path.join(appData, 'com.ccswitch.desktop', 'app_paths.json');
      const value = readBoundedJson(storePath, MAX_LIVE_STATE_BYTES)?.app_config_dir_override;
      if (typeof value === 'string' && value.length <= 4_096) {
        const raw = value.trim();
        const dir = home && raw === '~' ? home
          : home && (raw.startsWith('~/') || (process.platform === 'win32' && raw.startsWith('~\\')))
            ? path.join(home, raw.slice(2))
            : raw;
        if (path.isAbsolute(dir) && fs.statSync(dir).isDirectory()) {
          configuredDatabase = path.join(dir, 'cc-switch.db');
        }
      }
    } catch {}
  }
  if (!requestedDatabase || samePath(requestedDatabase, defaultDatabase)) {
    return { databasePath: configuredDatabase, deviceDirectory };
  }
  return {
    databasePath: requestedDatabase,
    deviceDirectory: samePath(requestedDatabase, configuredDatabase) ? deviceDirectory : path.dirname(requestedDatabase),
  };
}

function fileIdentity(stats) {
  return `${stats.dev || 0}:${stats.ino || 0}:${stats.birthtimeMs || 0}`;
}

function fileChangeIdentity(filename, statSync) {
  try {
    const stats = statSync(filename);
    return `${stats.dev || 0}:${stats.ino || 0}:${stats.size || 0}:${stats.mtimeMs || 0}`;
  } catch {
    return 'missing';
  }
}

function readCodexChatGptAuth(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_CODEX_AUTH_BYTES) return {};
    const buffer = Buffer.alloc(MAX_CODEX_AUTH_BYTES + 1);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > MAX_CODEX_AUTH_BYTES) return {};
    const auth = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (auth?.auth_mode != null && auth.auth_mode !== 'chatgpt') return {};
    const { account_id, access_token } = auth?.tokens || {};
    if (typeof account_id !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(account_id)
      || typeof access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(access_token)) return {};
    return { tokens: { account_id, access_token } };
  } finally {
    fs.closeSync(descriptor);
  }
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function optionalNonNegativeInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function parseRequestLogRow(row) {
  if (!row) return null;
  const createdAtSeconds = Number(row.created_at);
  const createdAt = new Date(createdAtSeconds * 1_000);
  const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    model: cleanText(row.model),
    requestModel: cleanText(row.request_model),
    inputTokens: nonNegativeInteger(row.input_tokens),
    outputTokens: nonNegativeInteger(row.output_tokens),
    cacheReadTokens: nonNegativeInteger(row.cache_read_tokens),
    cacheCreationTokens: nonNegativeInteger(row.cache_creation_tokens),
    totalCostUsd: nonNegativeNumber(row.total_cost_usd),
    latencyMs: optionalNonNegativeInteger(row.latency_ms),
    firstTokenMs: optionalNonNegativeInteger(row.first_token_ms),
    statusCode: nonNegativeInteger(row.status_code),
    createdAt: Number.isFinite(createdAtSeconds) && createdAtSeconds > 0 && Number.isFinite(createdAt.getTime())
      ? createdAt.toISOString()
      : '',
  };
}

export class ProviderRepository {
  constructor(databasePath, options = {}) {
    const env = options.env ?? process.env;
    const files = ccswitchFilePaths(databasePath, env);
    this.databasePath = files.databasePath;
    this.liveStatePath = path.join(files.deviceDirectory, 'live-state.json');
    this.settingsPath = path.join(files.deviceDirectory, 'settings.json');
    const codexHome = options.codexHome ?? getCodexHomeDir(env);
    this.codexAuthPath = codexHome ? path.join(codexHome, 'auth.json') : '';
    this.codexAuthSnapshot = null;
    this.unavailableCodexAuth = { auth: {} };
    this.databaseFactory = options.databaseFactory || (filename => new DatabaseSync(filename, { readOnly: true }));
    this.statSync = options.statSync || fs.statSync;
    this.database = null;
    this.databaseIdentity = null;
    this.currentStatement = null;
    this.byNameStatement = null;
    this.byIdStatement = null;
    this.allStatement = null;
    this.localUsageStatement = null;
    this.recentRequestsStatement = null;
    this.recentProxyRequestsStatement = null;
    this.credentialAppTypesStatement = null;
    this.currentCache = null;
    this.liveStateCache = null;
    this.deviceSelectionCache = null;
    this.byNameCache = new Map();
    this.byIdCache = new Map();
    this.allCache = null;
  }

  getCurrent() {
    const db = this.ensureDatabase();
    if (!this.currentStatement) {
      this.currentStatement = db.prepare(`
        SELECT ${PROVIDER_SELECT_COLUMNS}
        FROM providers
        WHERE app_type = 'codex' AND is_current = 1
        ORDER BY sort_index, name
        LIMIT 1
      `);
    }
    const selection = this.#currentSelection(db);
    const row = selection ? withCurrentProvider(selection.row, selection) : this.currentStatement.get();
    const signature = providerRowSignature(row);
    const authSnapshot = this.#authSnapshot(row);
    if (this.currentCache?.signature === signature && this.currentCache.authSnapshot === authSnapshot) return this.currentCache.value;
    const value = parseProviderRow(row, authSnapshot);
    this.currentCache = { signature, authSnapshot, value };
    return value;
  }

  getByName(name) {
    const db = this.ensureDatabase();
    if (!this.byNameStatement) {
      this.byNameStatement = db.prepare(`
        SELECT ${PROVIDER_SELECT_COLUMNS}
        FROM providers
        WHERE app_type = 'codex' AND name = ?
        LIMIT 1
      `);
    }
    const row = withCurrentProvider(this.byNameStatement.get(name), this.#currentSelection(db));
    const signature = providerRowSignature(row);
    const authSnapshot = this.#authSnapshot(row);
    const cached = this.byNameCache.get(name);
    if (cached?.signature === signature && cached.authSnapshot === authSnapshot) return cached.value;
    const value = parseProviderRow(row, authSnapshot);
    this.byNameCache.set(name, { signature, authSnapshot, value });
    return value;
  }

  getById(id) {
    const db = this.ensureDatabase();
    this.ensureByIdStatement(db);
    const key = String(id);
    const row = withCurrentProvider(this.byIdStatement.get(key), this.#currentSelection(db));
    const signature = providerRowSignature(row);
    const authSnapshot = this.#authSnapshot(row);
    const cached = this.byIdCache.get(key);
    if (cached?.signature === signature && cached.authSnapshot === authSnapshot) return cached.value;
    const value = parseProviderRow(row, authSnapshot);
    this.byIdCache.set(key, { signature, authSnapshot, value });
    return value;
  }

  ensureByIdStatement(db) {
    if (!this.byIdStatement) {
      this.byIdStatement = db.prepare(`
        SELECT ${PROVIDER_SELECT_COLUMNS}
        FROM providers
        WHERE app_type = 'codex' AND id = ?
        LIMIT 1
      `);
    }
  }

  #readSelection(filename, cacheKey, readId) {
    const changeToken = fileChangeIdentity(filename, this.statSync);
    if (this[cacheKey]?.changeToken !== changeToken) {
      if (changeToken === 'missing') {
        this[cacheKey] = { changeToken, id: null };
        return null;
      }
      try {
        this[cacheKey] = { changeToken, id: readId(filename) };
      } catch {
        this[cacheKey] = null;
        return null;
      }
    }
    return this[cacheKey]?.id || null;
  }

  #currentSelection(db) {
    const liveId = this.#readSelection(this.liveStatePath, 'liveStateCache', readLiveProviderId);
    if (liveId) {
      this.ensureByIdStatement(db);
      const live = this.byIdStatement.get(liveId);
      if (live) return { row: live, isProxyRoute: true };
    }
    const deviceId = this.#readSelection(this.settingsPath, 'deviceSelectionCache', readDeviceProviderId);
    if (!deviceId) return null;
    this.ensureByIdStatement(db);
    const direct = this.byIdStatement.get(deviceId);
    return direct ? { row: direct, isProxyRoute: false } : null;
  }

  getAll() {
    const db = this.ensureDatabase();
    if (!this.allStatement) {
      this.allStatement = db.prepare(`
        SELECT ${PROVIDER_SELECT_COLUMNS}
        FROM providers
        WHERE app_type = 'codex'
        ORDER BY COALESCE(sort_index, 2147483647), name
        LIMIT ${MAX_CODEX_PROVIDERS + 1}
      `);
    }
    const rows = this.allStatement.all();
    if (rows.length > MAX_CODEX_PROVIDERS) {
      throw new Error(`CCSwitch Codex 供应商数量超过安全上限 ${MAX_CODEX_PROVIDERS}`);
    }
    const selection = this.#currentSelection(db);
    const currentRows = selection ? rows.map(row => withCurrentProvider(row, selection)) : rows;
    const signature = JSON.stringify(currentRows.map(providerRowSignature));
    const authSnapshot = this.#authSnapshot(currentRows.find(currentOfficialRow));
    if (this.allCache?.signature === signature && this.allCache.authSnapshot === authSnapshot) return this.allCache.value;
    const value = currentRows.map(row => parseProviderRow(row, authSnapshot)).filter(Boolean);
    this.allCache = { signature, authSnapshot, value };
    return value;
  }

  #authSnapshot(row) {
    if (!currentOfficialRow(row)) return null;
    const signature = this.codexAuthPath ? fileChangeIdentity(this.codexAuthPath, this.statSync) : 'missing';
    if (signature === 'missing') {
      this.codexAuthSnapshot = null;
      return this.unavailableCodexAuth;
    }
    if (this.codexAuthSnapshot?.signature === signature) return this.codexAuthSnapshot;
    try {
      this.codexAuthSnapshot = { signature, auth: readCodexChatGptAuth(this.codexAuthPath) };
      return this.codexAuthSnapshot;
    } catch {
      this.codexAuthSnapshot = null;
      return this.unavailableCodexAuth;
    }
  }

  getLocalUsage(providerId) {
    const db = this.ensureDatabase();
    if (!this.localUsageStatement) {
      this.localUsageStatement = db.prepare(`
        SELECT COUNT(*) AS request_count,
               COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) AS total_cost
        FROM proxy_request_logs
        WHERE provider_id = ? AND app_type = 'codex'
      `);
    }
    const row = this.localUsageStatement.get(String(providerId)) || {};
    return {
      requestCount: Math.max(0, Number(row.request_count) || 0),
      totalCost: Math.max(0, Number(row.total_cost) || 0),
    };
  }

  getRecentRequests(providerId, limit = 10, { proxyOnly = false } = {}) {
    const db = this.ensureDatabase();
    const statement = proxyOnly ? 'recentProxyRequestsStatement' : 'recentRequestsStatement';
    if (!this[statement]) {
      this[statement] = db.prepare(`
        SELECT model, request_model, input_tokens, output_tokens,
               cache_read_tokens, cache_creation_tokens, total_cost_usd,
               latency_ms, first_token_ms, status_code, created_at
        FROM proxy_request_logs
        WHERE app_type = 'codex' AND provider_id = ?
          ${proxyOnly ? "AND data_source = 'proxy'" : ''}
        ORDER BY created_at DESC, request_id DESC
        LIMIT ?
      `);
    }
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 10)));
    return this[statement]
      .all(String(providerId), boundedLimit)
      .map(parseRequestLogRow)
      .filter(Boolean);
  }

  getCredentialAppTypes(credential) {
    const target = String(credential || '');
    if (!target) return [];
    const db = this.ensureDatabase();
    if (!this.credentialAppTypesStatement) {
      this.credentialAppTypesStatement = db.prepare(`
        SELECT substr(app_type, 1, 64) AS app_type, settings_config
        FROM providers
        WHERE length(settings_config) <= ${MAX_PROVIDER_CONFIG_CHARS}
          AND (instr(settings_config, ?) > 0 OR instr(settings_config, ?) > 0)
        LIMIT ${MAX_CREDENTIAL_MATCH_ROWS + 1}
      `);
    }
    const appTypes = new Set();
    const escapedTarget = JSON.stringify(target).slice(1, -1);
    const rows = this.credentialAppTypesStatement.all(target, escapedTarget);
    if (rows.length > MAX_CREDENTIAL_MATCH_ROWS) return ['unknown'];
    for (const row of rows) {
      const settings = parseJson(row.settings_config, {});
      if (providerCredentialValues(settings).includes(target)) appTypes.add(String(row.app_type || ''));
    }
    return [...appTypes].filter(Boolean).sort();
  }

  getChangeToken() {
    return [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`, this.liveStatePath, this.settingsPath, this.codexAuthPath].filter(Boolean)
      .map(filename => fileChangeIdentity(filename, this.statSync))
      .join('|');
  }

  ensureDatabase() {
    let identity = this.databaseIdentity;
    try {
      identity = fileIdentity(this.statSync(this.databasePath));
    } catch {
      if (!this.database) throw new Error(`CCSwitch 数据库不存在: ${this.databasePath}`);
    }
    if (this.database && identity === this.databaseIdentity) return this.database;
    this.close();
    this.database = this.databaseFactory(this.databasePath);
    this.databaseIdentity = identity;
    return this.database;
  }

  close() {
    try { this.database?.close(); } catch {}
    this.database = null;
    this.databaseIdentity = null;
    this.currentStatement = null;
    this.byNameStatement = null;
    this.byIdStatement = null;
    this.allStatement = null;
    this.localUsageStatement = null;
    this.recentRequestsStatement = null;
    this.recentProxyRequestsStatement = null;
    this.credentialAppTypesStatement = null;
    this.currentCache = null;
    this.liveStateCache = null;
    this.deviceSelectionCache = null;
    this.codexAuthSnapshot = null;
    this.byNameCache.clear();
    this.byIdCache.clear();
    this.allCache = null;
  }
}
