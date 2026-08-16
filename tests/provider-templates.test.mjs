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
import { resetHttpAllowlistCache } from '../src/http-allowlist.mjs';

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

test('provider template store commits memory only after persistence succeeds', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-template-atomic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const blocker = path.join(directory, 'blocked-parent');
  fs.writeFileSync(blocker, 'not a directory');
  const store = new ProviderTemplateStore(path.join(blocker, 'bindings.json'));
  const item = provider();

  assert.throws(() => store.set(item, { balanceTemplateId: 'new-api-key-quota' }));
  assert.equal(store.get(item), null);
});

test('provider template store rejects oversized, wrong-version, and unsafe binding files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-template-bounds-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const item = provider();
  const oversized = path.join(directory, 'oversized.json');
  fs.writeFileSync(oversized, '{');
  fs.truncateSync(oversized, 262_145);
  assert.equal(new ProviderTemplateStore(oversized).get(item), null);

  const invalid = path.join(directory, 'invalid.json');
  fs.writeFileSync(invalid, JSON.stringify({
    version: 2,
    providers: {
      'provider-one': {
        origin: 'https://user:password@api.example.test',
        balanceTemplateId: 'new-api-key-quota',
      },
    },
  }));
  assert.equal(new ProviderTemplateStore(invalid).get(item), null);
  assert.throws(
    () => new ProviderTemplateStore(path.join(directory, 'write.json')).set({ ...item, id: 'x'.repeat(161) }, { balanceTemplateId: 'new-api-key-quota' }),
    /供应商 ID 不能为空/,
  );
});

test('provider template store restores an explicitly allowlisted HTTP binding by provider id', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-template-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const allowlist = path.join(directory, 'allow-http-origins.json');
  fs.writeFileSync(allowlist, JSON.stringify({ providers: { 'provider-one': ['http://127.0.0.1:18080'] } }));
  const previousAllowlist = process.env.CCSWITCH_HTTP_ALLOWLIST_FILE;
  process.env.CCSWITCH_HTTP_ALLOWLIST_FILE = allowlist;
  resetHttpAllowlistCache();
  t.after(() => {
    if (previousAllowlist === undefined) delete process.env.CCSWITCH_HTTP_ALLOWLIST_FILE;
    else process.env.CCSWITCH_HTTP_ALLOWLIST_FILE = previousAllowlist;
    resetHttpAllowlistCache();
  });
  const filename = path.join(directory, 'bindings.json');
  const item = provider({ apiBaseUrl: 'http://127.0.0.1:18080/v1', baseUrl: 'http://127.0.0.1:18080/v1' });
  const saved = new ProviderTemplateStore(filename).set(item, { balanceTemplateId: 'new-api-key-quota' });

  assert.equal(saved.origin, 'http://127.0.0.1:18080');
  assert.deepEqual(new ProviderTemplateStore(filename).get(item), saved);
});
