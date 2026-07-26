import fs from 'node:fs';
import path from 'node:path';

const SORT_OPTIONS = new Set(['smart', 'name', 'remaining', 'updated', 'latency']);
const VIEW_OPTIONS = new Set(['cards', 'compact']);
const MAX_FAVORITES = 256;
const MAX_IGNORED_PROVIDERS = 256;
const MAX_BROWSER_ALIASES = 32;
const MAX_PROVIDER_BROWSERS = 256;

function cleanProviderId(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text && text.length <= 160 ? text : '';
}

function cleanClientRef(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(text) ? text : '';
}

function cleanAlias(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function cleanBrowser(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'edge') return 'Edge';
  if (text === 'chrome') return 'Chrome';
  if (text === 'chromium') return 'Chromium';
  return '';
}

function normalizeFavorites(values) {
  const favorites = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanProviderId(value);
    if (id && !favorites.includes(id)) favorites.push(id);
    if (favorites.length >= MAX_FAVORITES) break;
  }
  return favorites;
}

function normalizeIgnoredProviders(values) {
  const providers = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanProviderId(value);
    if (id && !providers.includes(id)) providers.push(id);
    if (providers.length >= MAX_IGNORED_PROVIDERS) break;
  }
  return providers;
}

function normalizeBrowserAliases(value) {
  const aliases = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return aliases;
  for (const [rawRef, rawLabel] of Object.entries(value)) {
    const ref = cleanClientRef(rawRef);
    const label = cleanAlias(rawLabel);
    if (ref && label) aliases[ref] = label;
    if (Object.keys(aliases).length >= MAX_BROWSER_ALIASES) break;
  }
  return aliases;
}

function normalizeProviderBrowsers(value) {
  const providerBrowsers = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return providerBrowsers;
  for (const [rawProviderId, rawPreference] of Object.entries(value)) {
    const providerId = cleanProviderId(rawProviderId);
    const clientRef = cleanClientRef(rawPreference?.clientRef);
    const browser = cleanBrowser(rawPreference?.browser);
    if (providerId && clientRef && browser) providerBrowsers[providerId] = { clientRef, browser };
    if (Object.keys(providerBrowsers).length >= MAX_PROVIDER_BROWSERS) break;
  }
  return providerBrowsers;
}

export function normalizeHubPreferences(value = {}) {
  const sort = SORT_OPTIONS.has(String(value?.sort || '')) ? String(value.sort) : 'smart';
  const view = VIEW_OPTIONS.has(String(value?.view || '')) ? String(value.view) : 'cards';
  return {
    version: 3,
    setupComplete: value?.setupComplete === true,
    favorites: normalizeFavorites(value?.favorites),
    ignoredProviders: normalizeIgnoredProviders(value?.ignoredProviders),
    sort,
    view,
    browserAliases: normalizeBrowserAliases(value?.browserAliases),
    providerBrowsers: normalizeProviderBrowsers(value?.providerBrowsers),
  };
}

function readPreferences(filePath) {
  if (!filePath) return normalizeHubPreferences();
  try {
    return normalizeHubPreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return normalizeHubPreferences();
  }
}

export class HubPreferences {
  constructor(filePath = '') {
    this.filePath = String(filePath || '');
    this.value = readPreferences(this.filePath);
  }

  get() {
    return {
      ...this.value,
      favorites: [...this.value.favorites],
      ignoredProviders: [...this.value.ignoredProviders],
      browserAliases: { ...this.value.browserAliases },
      providerBrowsers: Object.fromEntries(
        Object.entries(this.value.providerBrowsers).map(([providerId, value]) => [providerId, { ...value }]),
      ),
    };
  }

  update(patch = {}) {
    const next = this.get();
    if (Object.prototype.hasOwnProperty.call(patch, 'setupComplete')) {
      next.setupComplete = patch.setupComplete === true;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'favorites')) {
      next.favorites = normalizeFavorites(patch.favorites);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'ignoredProviders')) {
      next.ignoredProviders = normalizeIgnoredProviders(patch.ignoredProviders);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sort')) {
      const sort = String(patch.sort || '');
      if (!SORT_OPTIONS.has(sort)) throw new Error('排序方式无效');
      next.sort = sort;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'view')) {
      const view = String(patch.view || '');
      if (!VIEW_OPTIONS.has(view)) throw new Error('视图方式无效');
      next.view = view;
    }
    if (patch.favorite && typeof patch.favorite === 'object') {
      const providerId = cleanProviderId(patch.favorite.providerId);
      if (!providerId) throw new Error('供应商标识无效');
      const favorites = new Set(next.favorites);
      if (patch.favorite.enabled === true) favorites.add(providerId);
      else favorites.delete(providerId);
      next.favorites = normalizeFavorites([...favorites]);
    }
    if (patch.ignoredProvider && typeof patch.ignoredProvider === 'object') {
      const providerId = cleanProviderId(patch.ignoredProvider.providerId);
      if (!providerId) throw new Error('供应商标识无效');
      const ignoredProviders = new Set(next.ignoredProviders);
      if (patch.ignoredProvider.ignored === true) ignoredProviders.add(providerId);
      else ignoredProviders.delete(providerId);
      next.ignoredProviders = normalizeIgnoredProviders([...ignoredProviders]);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'browserAliases')) {
      next.browserAliases = normalizeBrowserAliases(patch.browserAliases);
    }
    if (patch.browserAlias && typeof patch.browserAlias === 'object') {
      const clientRef = cleanClientRef(patch.browserAlias.clientRef);
      if (!clientRef) throw new Error('浏览器标识无效');
      const label = cleanAlias(patch.browserAlias.label);
      if (label) next.browserAliases[clientRef] = label;
      else delete next.browserAliases[clientRef];
      next.browserAliases = normalizeBrowserAliases(next.browserAliases);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'providerBrowsers')) {
      next.providerBrowsers = normalizeProviderBrowsers(patch.providerBrowsers);
    }
    if (patch.providerBrowser && typeof patch.providerBrowser === 'object') {
      const providerId = cleanProviderId(patch.providerBrowser.providerId);
      if (!providerId) throw new Error('供应商标识无效');
      if (patch.providerBrowser.clear === true) {
        delete next.providerBrowsers[providerId];
      } else {
        const clientRef = cleanClientRef(patch.providerBrowser.clientRef);
        const browser = cleanBrowser(patch.providerBrowser.browser);
        if (!clientRef || !browser) throw new Error('供应商浏览器偏好无效');
        next.providerBrowsers[providerId] = { clientRef, browser };
      }
      next.providerBrowsers = normalizeProviderBrowsers(next.providerBrowsers);
    }
    this.value = normalizeHubPreferences(next);
    this.#write();
    return this.get();
  }

  #write() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}
