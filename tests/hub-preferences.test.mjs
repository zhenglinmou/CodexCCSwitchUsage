import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HubPreferences, normalizeHubPreferences } from '../src/hub-preferences.mjs';

test('Hub preferences normalize bounded non-secret UI state', () => {
  assert.deepEqual(normalizeHubPreferences({
    setupComplete: true,
    favorites: ['one', 'one', '', 'two'],
    ignoredProviders: ['old', 'old', '', 'retired'],
    sort: 'latency',
    view: 'compact',
    browserAliases: {
      'chrome-ref-one': '  Chrome\n主账号  ',
      invalid: 'ignored',
    },
    providerBrowsers: {
      one: { clientRef: 'chrome-ref-one', browser: 'chrome' },
      invalid: { clientRef: '../unsafe', browser: 'Edge' },
    },
  }), {
    version: 3,
    setupComplete: true,
    favorites: ['one', 'two'],
    ignoredProviders: ['old', 'retired'],
    sort: 'latency',
    view: 'compact',
    browserAliases: { 'chrome-ref-one': 'Chrome 主账号' },
    providerBrowsers: { one: { clientRef: 'chrome-ref-one', browser: 'Chrome' } },
  });
});

test('Hub preferences persist view, favorites, sorting, browser aliases, and provider browser choices', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hub-preferences-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'hub-preferences.json');
  const preferences = new HubPreferences(filename);

  preferences.update({ favorite: { providerId: 'provider-one', enabled: true } });
  preferences.update({ setupComplete: true });
  preferences.update({ ignoredProvider: { providerId: 'provider-old', ignored: true } });
  preferences.update({ sort: 'updated' });
  preferences.update({ view: 'compact' });
  preferences.update({ browserAlias: { clientRef: 'edge-ref-one', label: 'Edge 公益站账号' } });
  preferences.update({ providerBrowser: { providerId: 'provider-one', clientRef: 'edge-ref-one', browser: 'Edge' } });

  assert.deepEqual(new HubPreferences(filename).get(), {
    version: 3,
    setupComplete: true,
    favorites: ['provider-one'],
    ignoredProviders: ['provider-old'],
    sort: 'updated',
    view: 'compact',
    browserAliases: { 'edge-ref-one': 'Edge 公益站账号' },
    providerBrowsers: { 'provider-one': { clientRef: 'edge-ref-one', browser: 'Edge' } },
  });
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /api[_ -]?key|cookie|bearer/i);

  preferences.update({ favorite: { providerId: 'provider-one', enabled: false } });
  preferences.update({ ignoredProvider: { providerId: 'provider-old', ignored: false } });
  preferences.update({ browserAlias: { clientRef: 'edge-ref-one', label: '' } });
  preferences.update({ providerBrowser: { providerId: 'provider-one', clear: true } });
  assert.deepEqual(preferences.get().favorites, []);
  assert.deepEqual(preferences.get().ignoredProviders, []);
  assert.deepEqual(preferences.get().browserAliases, {});
  assert.deepEqual(preferences.get().providerBrowsers, {});
  assert.throws(() => preferences.update({ sort: 'unknown' }), /排序方式无效/);
  assert.throws(() => preferences.update({ view: 'unknown' }), /视图方式无效/);
  assert.throws(() => preferences.update({ browserAlias: { clientRef: '../unsafe', label: 'bad' } }), /浏览器标识无效/);
  assert.throws(() => preferences.update({ providerBrowser: { providerId: 'provider-one', clientRef: 'edge-ref-one', browser: 'Firefox' } }), /供应商浏览器偏好无效/);
});
