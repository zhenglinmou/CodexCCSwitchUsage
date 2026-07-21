import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function findBaseUrl(configText = '') {
  const matches = [...String(configText).matchAll(/^\s*base_url\s*=\s*["']([^"']+)["']/gmi)];
  return matches.at(-1)?.[1]?.replace(/\/+$/, '') ?? '';
}

export function parseProviderRow(row) {
  if (!row) return null;
  const settings = parseJson(row.settings_config, {});
  const meta = parseJson(row.meta, {});
  const usage = meta?.usage_script;
  const auth = settings?.auth && typeof settings.auth === 'object' ? settings.auth : {};
  const apiBaseUrl = findBaseUrl(settings?.config || '');

  return {
    id: String(row.id),
    name: String(row.name || '当前供应商'),
    websiteUrl: row.website_url || '',
    isCurrent: Boolean(row.is_current),
    sortIndex: row.sort_index != null && Number.isFinite(Number(row.sort_index)) ? Number(row.sort_index) : null,
    usage: usage && typeof usage === 'object' ? usage : null,
    auth,
    apiKey: String(auth.OPENAI_API_KEY || auth.openai_api_key || ''),
    apiBaseUrl,
    baseUrl: String(usage?.baseUrl || apiBaseUrl).replace(/\/+$/, ''),
  };
}

function providerRowSignature(row) {
  if (!row) return 'null';
  return JSON.stringify([
    row.id,
    row.name,
    row.website_url,
    row.is_current,
    row.sort_index,
    row.settings_config,
    row.meta,
  ]);
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
  constructor(databasePath = path.join(process.env.USERPROFILE, '.cc-switch', 'cc-switch.db'), options = {}) {
    this.databasePath = databasePath;
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
    this.currentCache = null;
    this.byNameCache = new Map();
    this.byIdCache = new Map();
    this.allCache = null;
  }

  getCurrent() {
    const db = this.ensureDatabase();
    if (!this.currentStatement) {
      this.currentStatement = db.prepare(`
        SELECT id, name, website_url, is_current, sort_index, settings_config, meta
        FROM providers
        WHERE app_type = 'codex' AND is_current = 1
        ORDER BY sort_index, name
        LIMIT 1
      `);
    }
    const row = this.currentStatement.get();
    const signature = providerRowSignature(row);
    if (this.currentCache?.signature === signature) return this.currentCache.value;
    const value = parseProviderRow(row);
    this.currentCache = { signature, value };
    return value;
  }

  getByName(name) {
    const db = this.ensureDatabase();
    if (!this.byNameStatement) {
      this.byNameStatement = db.prepare(`
        SELECT id, name, website_url, is_current, sort_index, settings_config, meta
        FROM providers
        WHERE app_type = 'codex' AND name = ?
        LIMIT 1
      `);
    }
    const row = this.byNameStatement.get(name);
    const signature = providerRowSignature(row);
    const cached = this.byNameCache.get(name);
    if (cached?.signature === signature) return cached.value;
    const value = parseProviderRow(row);
    this.byNameCache.set(name, { signature, value });
    return value;
  }

  getById(id) {
    const db = this.ensureDatabase();
    if (!this.byIdStatement) {
      this.byIdStatement = db.prepare(`
        SELECT id, name, website_url, is_current, sort_index, settings_config, meta
        FROM providers
        WHERE app_type = 'codex' AND id = ?
        LIMIT 1
      `);
    }
    const key = String(id);
    const row = this.byIdStatement.get(key);
    const signature = providerRowSignature(row);
    const cached = this.byIdCache.get(key);
    if (cached?.signature === signature) return cached.value;
    const value = parseProviderRow(row);
    this.byIdCache.set(key, { signature, value });
    return value;
  }

  getAll() {
    const db = this.ensureDatabase();
    if (!this.allStatement) {
      this.allStatement = db.prepare(`
        SELECT id, name, website_url, is_current, sort_index, settings_config, meta
        FROM providers
        WHERE app_type = 'codex'
        ORDER BY COALESCE(sort_index, 2147483647), name
      `);
    }
    const rows = this.allStatement.all();
    const signature = JSON.stringify(rows.map(providerRowSignature));
    if (this.allCache?.signature === signature) return this.allCache.value;
    const value = rows.map(parseProviderRow).filter(Boolean);
    this.allCache = { signature, value };
    return value;
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

  getRecentRequests(providerId, limit = 10) {
    const db = this.ensureDatabase();
    if (!this.recentRequestsStatement) {
      this.recentRequestsStatement = db.prepare(`
        SELECT model, request_model, input_tokens, output_tokens,
               cache_read_tokens, cache_creation_tokens, total_cost_usd,
               latency_ms, first_token_ms, status_code, created_at
        FROM proxy_request_logs
        WHERE app_type = 'codex' AND provider_id = ?
        ORDER BY created_at DESC, request_id DESC
        LIMIT ?
      `);
    }
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 10)));
    return this.recentRequestsStatement
      .all(String(providerId), boundedLimit)
      .map(parseRequestLogRow)
      .filter(Boolean);
  }

  getChangeToken() {
    return [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]
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
    this.currentCache = null;
    this.byNameCache.clear();
    this.byIdCache.clear();
    this.allCache = null;
  }
}
