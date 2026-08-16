import fs from 'node:fs';
import path from 'node:path';
import { secureAtomicWriteFileSync } from './secure-files.mjs';
import { isTrustedHttpUrl } from './http-allowlist.mjs';

export const PROVIDER_TEMPLATE_REGISTRY_VERSION = 2;
const MAX_TEMPLATE_BINDINGS_BYTES = 262_144;
const MAX_TEMPLATE_BINDINGS = 256;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cleanProviderId(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text && text.length <= 160 && !RESERVED_OBJECT_KEYS.has(text) ? text : '';
}

function safeStoredOrigin(value, providerId) {
  const text = String(value || '').trim();
  if (!text || text.length > 512) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) return '';
    if (url.protocol !== 'https:' && !isTrustedHttpUrl(url, { id: providerId, apiBaseUrl: url.origin })) return '';
    return url.origin;
  } catch {
    return '';
  }
}

const BALANCE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'new-api-key-quota',
    label: 'New API 标准 Key 额度',
    description: '使用标准 /api/usage/token/ 与 /api/status；有限 Key 直查，无限 Key 转账户额度。',
    family: 'new-api',
    variant: 'standard-key-quota',
    selectable: true,
    autoDetect: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'new-api-browser-account',
    label: 'New API 浏览器账户额度',
    description: '使用当前浏览器 Cookie、数字用户 ID 与 /api/user/self。',
    family: 'new-api',
    variant: 'browser-account-quota',
    selectable: true,
    autoDetect: true,
    requiresBrowser: true,
  }),
  Object.freeze({
    id: 'deepseek-balance',
    label: 'DeepSeek 余额结构',
    description: '使用 /user/balance 的 balance_infos 响应结构。',
    selectable: true,
    autoDetect: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'packy-balance',
    label: 'New API 重置周期有效额度（Packy 类）',
    description: '使用 /api/usage/token/ 的 total_available、total_used 与 quota_reset_period；有限或无限 Key 均可免登录直查。',
    family: 'new-api',
    variant: 'reset-period-effective-key-quota',
    selectable: true,
    autoDetect: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'window-balance',
    label: '3H / 1D 窗口额度',
    description: '使用 /user/balance 的短窗口与日窗口响应结构。',
    selectable: true,
    autoDetect: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'api-health-local',
    label: '模型 API 检查 + 本地统计',
    description: '检查 /models，并显示 CCSwitch 本地累计费用。',
    selectable: true,
    autoDetect: false,
    fallback: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'openai-wham',
    label: 'OpenAI 账户额度',
    description: '使用 OpenAI WHAM 账户接口。',
    selectable: false,
    autoDetect: false,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'cpa-local',
    label: 'CLIProxyAPI 本地账号汇总',
    description: '读取本机 CLIProxyAPI Codex 账号并汇总。',
    selectable: false,
    autoDetect: false,
    requiresBrowser: false,
  }),
]);

const REQUEST_USAGE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'openai-codex-session',
    label: 'Codex 官方会话 Token',
    description: '读取本机 Codex 官方会话 token_count；Token 精确，ChatGPT 套餐不提供逐请求金额。',
    family: 'openai',
    variant: 'codex-session-token-count',
    selectable: false,
    autoDetect: false,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'new-api-token-log',
    label: 'New API 逐请求日志',
    description: '优先使用 /api/log/token 与 /api/status；仅在账户日志可严格归属到同一 Token 时回退 /api/log/self。',
    family: 'new-api',
    variant: 'token-request-log',
    selectable: true,
    autoDetect: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'ccswitch-local',
    label: 'CCSwitch 本地请求记录',
    description: '使用 proxy_request_logs；费用为本地估算。',
    selectable: true,
    autoDetect: false,
    fallback: true,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'response-usage-only',
    label: '仅模型响应 usage',
    description: '供应商没有可查询的历史逐请求接口。',
    selectable: false,
    autoDetect: false,
    requiresBrowser: false,
  }),
  Object.freeze({
    id: 'website-session-only',
    label: '仅官网登录记录',
    description: '真实消费记录只在官网登录接口中提供。',
    selectable: false,
    autoDetect: false,
    requiresBrowser: true,
  }),
]);

const BALANCE_TEMPLATE_MAP = new Map(BALANCE_TEMPLATES.map(template => [template.id, template]));
const REQUEST_USAGE_TEMPLATE_MAP = new Map(REQUEST_USAGE_TEMPLATES.map(template => [template.id, template]));

function publicTemplate(template) {
  return { ...template };
}

export function listProviderTemplates() {
  return {
    version: PROVIDER_TEMPLATE_REGISTRY_VERSION,
    balance: BALANCE_TEMPLATES.map(publicTemplate),
    requestUsage: REQUEST_USAGE_TEMPLATES.map(publicTemplate),
  };
}

export function getBalanceTemplate(templateId) {
  return BALANCE_TEMPLATE_MAP.get(String(templateId || '')) || null;
}

export function getRequestUsageTemplate(templateId) {
  return REQUEST_USAGE_TEMPLATE_MAP.get(String(templateId || '')) || null;
}

export function normalizeProviderTemplateOrigin(provider) {
  const value = String(provider?.apiBaseUrl || provider?.baseUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !isTrustedHttpUrl(url, provider)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function safeBinding(providerId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const balanceTemplateId = String(value.balanceTemplateId || '');
  const requestUsageTemplateId = String(value.requestUsageTemplateId || '');
  if (balanceTemplateId && !getBalanceTemplate(balanceTemplateId)) return null;
  if (requestUsageTemplateId && !getRequestUsageTemplate(requestUsageTemplateId)) return null;
  if (!balanceTemplateId && !requestUsageTemplateId) return null;
  const normalizedProviderId = cleanProviderId(providerId);
  const origin = safeStoredOrigin(value.origin, normalizedProviderId);
  if (!normalizedProviderId || !origin) return null;
  const updatedAtValue = String(value.updatedAt || '').slice(0, 64);
  const updatedAtMs = Date.parse(updatedAtValue);
  return {
    providerId: normalizedProviderId,
    origin,
    balanceTemplateId,
    requestUsageTemplateId,
    registryVersion: Number.isSafeInteger(Number(value.registryVersion))
      ? Math.max(1, Math.min(10_000, Number(value.registryVersion)))
      : PROVIDER_TEMPLATE_REGISTRY_VERSION,
    updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : '',
  };
}

function readBindings(filename) {
  if (!filename) return new Map();
  try {
    const stats = fs.statSync(filename);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_TEMPLATE_BINDINGS_BYTES) return new Map();
    const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (payload?.version !== 1) return new Map();
    const providers = payload?.providers && typeof payload.providers === 'object' && !Array.isArray(payload.providers)
      ? payload.providers
      : {};
    const entries = [];
    for (const [providerId, value] of Object.entries(providers)) {
      const binding = safeBinding(providerId, value);
      if (binding) entries.push([providerId, binding]);
      if (entries.length >= MAX_TEMPLATE_BINDINGS) break;
    }
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export class ProviderTemplateStore {
  constructor(filename, options = {}) {
    this.filename = String(filename || '');
    this.now = options.now || Date.now;
    this.bindings = readBindings(this.filename);
  }

  get(provider) {
    const providerId = cleanProviderId(provider?.id);
    const origin = normalizeProviderTemplateOrigin(provider);
    const binding = this.bindings.get(providerId);
    if (!binding || !origin || binding.origin !== origin) return null;
    return { ...binding };
  }

  set(provider, selection = {}) {
    const providerId = cleanProviderId(provider?.id);
    const origin = normalizeProviderTemplateOrigin(provider);
    if (!providerId) throw new Error('供应商 ID 不能为空');
    if (!origin) throw new Error('供应商没有可安全绑定模板的 HTTPS Base URL');
    const balanceTemplateId = String(selection.balanceTemplateId || '');
    const requestUsageTemplateId = String(selection.requestUsageTemplateId || '');
    if (balanceTemplateId && !getBalanceTemplate(balanceTemplateId)) throw new Error('余额模板不存在');
    if (requestUsageTemplateId && !getRequestUsageTemplate(requestUsageTemplateId)) throw new Error('逐请求模板不存在');
    if (!balanceTemplateId && !requestUsageTemplateId) return this.clear(providerId);
    const binding = {
      providerId,
      origin,
      balanceTemplateId,
      requestUsageTemplateId,
      registryVersion: PROVIDER_TEMPLATE_REGISTRY_VERSION,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const nextBindings = new Map(this.bindings);
    if (!nextBindings.has(providerId) && nextBindings.size >= MAX_TEMPLATE_BINDINGS) {
      throw new Error('供应商模板绑定数量已达到上限');
    }
    nextBindings.set(providerId, binding);
    this.#write(nextBindings);
    this.bindings = nextBindings;
    return { ...binding };
  }

  clear(providerId) {
    const key = cleanProviderId(providerId);
    if (!this.bindings.has(key)) return null;
    const nextBindings = new Map(this.bindings);
    nextBindings.delete(key);
    this.#write(nextBindings);
    this.bindings = nextBindings;
    return null;
  }

  #write(bindings) {
    if (!this.filename) return;
    const providers = Object.fromEntries(
      [...bindings.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([providerId, binding]) => [providerId, { ...binding, providerId: undefined }]),
    );
    for (const value of Object.values(providers)) delete value.providerId;
    const serialized = JSON.stringify({
      version: 1,
      registryVersion: PROVIDER_TEMPLATE_REGISTRY_VERSION,
      providers,
    }, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TEMPLATE_BINDINGS_BYTES) throw new Error('供应商模板绑定过大');
    secureAtomicWriteFileSync(this.filename, serialized, { encoding: 'utf8' });
  }
}
