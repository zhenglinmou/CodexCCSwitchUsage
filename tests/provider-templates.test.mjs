import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getBalanceTemplate,
  getRequestUsageTemplate,
  listProviderTemplates,
  normalizeProviderTemplateOrigin,
  ProviderTemplateStore,
} from '../src/provider-templates.mjs';

function provider(overrides = {}) {
  return {
    id: 'provider-one',
    apiBaseUrl: 'https://api.example.test/v1',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'private-key-that-must-not-be-stored',
    ...overrides,
  };
}

test('provider template catalog exposes independent balance and request usage choices', () => {
  const catalog = listProviderTemplates();
  assert.equal(catalog.version, 2);
  assert.equal(getBalanceTemplate('new-api-key-quota')?.selectable, true);
  assert.equal(getBalanceTemplate('new-api-key-quota')?.family, 'new-api');
  assert.equal(getBalanceTemplate('new-api-key-quota')?.variant, 'standard-key-quota');
  assert.equal(getBalanceTemplate('packy-balance')?.family, 'new-api');
  assert.equal(getBalanceTemplate('packy-balance')?.variant, 'reset-period-effective-key-quota');
  assert.equal(getBalanceTemplate('openai-wham')?.selectable, false);
  assert.equal(getRequestUsageTemplate('new-api-token-log')?.autoDetect, true);
  assert.equal(getRequestUsageTemplate('new-api-token-log')?.family, 'new-api');
  assert.equal(getRequestUsageTemplate('openai-codex-session')?.selectable, false);
  assert.equal(getRequestUsageTemplate('ccswitch-local')?.fallback, true);
  assert.ok(catalog.balance.length >= 6);
  assert.ok(catalog.requestUsage.length >= 2);
});

test('provider template origins stay pinned to the configured safe API origin', () => {
  assert.equal(normalizeProviderTemplateOrigin(provider()), 'https://api.example.test');
  assert.equal(normalizeProviderTemplateOrigin(provider({ apiBaseUrl: 'http://remote.example.test/v1' })), '');
  assert.equal(normalizeProviderTemplateOrigin(provider({ apiBaseUrl: 'http://127.0.0.1:8317/v1' })), 'http://127.0.0.1:8317');
});

test('provider template store persists template ids without credentials and invalidates changed origins', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-template-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'hub-template-bindings.json');
  const now = () => Date.parse('2026-07-26T00:00:00.000Z');
  const store = new ProviderTemplateStore(filename, { now });
  const item = provider();

  const saved = store.set(item, {
    balanceTemplateId: 'new-api-key-quota',
    requestUsageTemplateId: 'new-api-token-log',
  });
  assert.equal(saved.origin, 'https://api.example.test');
  assert.deepEqual(store.get(item), saved);

  const text = fs.readFileSync(filename, 'utf8');
  assert.doesNotMatch(text, /private-key-that-must-not-be-stored/);
  assert.match(text, /new-api-key-quota/);
  assert.deepEqual(new ProviderTemplateStore(filename).get(item), saved);
  assert.equal(store.get({ ...item, apiBaseUrl: 'https://other.example.test/v1' }), null);

  store.clear(item.id);
  assert.equal(store.get(item), null);
});
