import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './platform.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_LOOPBACK_PORTS = new Set(['8317']);
const CACHE_TTL_MS = 5_000;
const MAX_ALLOWLIST_BYTES = 64 * 1024;
const MAX_PROVIDERS = 64;
const MAX_ORIGINS_PER_PROVIDER = 8;

let cachedOrigins = null;
let cachedAt = 0;

function allowlistFilePath() {
  const override = String(process.env.CCSWITCH_HTTP_ALLOWLIST_FILE || '').trim();
  if (override) return path.resolve(override);
  const home = getHomeDir();
  if (!home) return '';
  return path.join(home, '.cc-switch', 'allow-http-origins.json');
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function normalizeProviderId(value) {
  return String(typeof value === 'string' ? value : value?.id || '').trim();
}

function normalizeHttpOrigin(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value || '').trim());
    if (url.protocol !== 'http:' || !url.hostname || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function readConfiguredOrigins() {
  const now = Date.now();
  if (cachedOrigins && now - cachedAt < CACHE_TTL_MS) return cachedOrigins;
  const providers = new Map();
  const filename = allowlistFilePath();
  if (filename) {
    try {
      if (fs.statSync(filename).size > MAX_ALLOWLIST_BYTES) throw new Error('HTTP allowlist is too large');
      const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
      const configured = payload?.providers && typeof payload.providers === 'object' && !Array.isArray(payload.providers)
        ? payload.providers
        : {};
      for (const [providerId, rawOrigins] of Object.entries(configured).slice(0, MAX_PROVIDERS)) {
        const id = normalizeProviderId(providerId);
        if (!id) continue;
        const origins = new Set();
        const values = Array.isArray(rawOrigins) ? rawOrigins : [rawOrigins];
        for (const value of values.slice(0, MAX_ORIGINS_PER_PROVIDER)) {
          const origin = normalizeHttpOrigin(value);
          if (origin) origins.add(origin);
        }
        if (origins.size) providers.set(id, origins);
      }
    } catch {}
  }
  cachedOrigins = providers;
  cachedAt = now;
  return providers;
}

export function isTrustedHttpUrl(value, provider = null) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value || '').trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !url.hostname) return false;
  if (url.username || url.password) return false;
  const hostname = normalizeHost(url.hostname);
  if (LOOPBACK_HOSTS.has(hostname) && DEFAULT_LOOPBACK_PORTS.has(url.port)) return true;
  const providerId = normalizeProviderId(provider);
  return Boolean(providerId && readConfiguredOrigins().get(providerId)?.has(url.origin));
}

export function resetHttpAllowlistCache() {
  cachedOrigins = null;
  cachedAt = 0;
}
