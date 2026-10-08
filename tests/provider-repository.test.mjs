import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseProviderRow, ProviderRepository } from '../src/provider-repository.mjs';

function liveStateRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-live-state-'));
  const databasePath = path.join(directory, 'cc-switch.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE providers (
      id TEXT, app_type TEXT, name TEXT, website_url TEXT, is_current INTEGER,
      sort_index INTEGER, settings_config TEXT DEFAULT '{}', meta TEXT DEFAULT '{}',
      PRIMARY KEY (id, app_type)
    );
    INSERT INTO providers (id, app_type, name, is_current, sort_index) VALUES
      ('tyz', 'codex', '允熙官方 -tyz-外网', 1, 0),
      ('zlm', 'codex', '允熙官方-zlm-外网', 0, 1),
      ('claude-only', 'claude', 'Claude', 1, 0);
  `);
  const repository = new ProviderRepository(databasePath);
  t.after(() => {
    repository.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let revision = 0;
  const writeState = value => {
    fs.writeFileSync(repository.liveStatePath, typeof value === 'string' ? value : JSON.stringify(value));
    const timestamp = new Date(Date.now() + ++revision * 1_000);
    fs.utimesSync(repository.liveStatePath, timestamp, timestamp);
  };
  return { repository, database, writeState };
}

function proxyLiveState(id, overrides = {}) {
  return { version: 1, apps: { codex: { mode: 'proxy', attached: true, proxy_route: id, ...overrides } } };
}

test('CCSwitch proxy live route overrides the stale SQLite selection across repository views', t => {
  const { repository, database, writeState } = liveStateRepository(t);
  assert.equal(repository.getCurrent().id, 'tyz');
  const legacyAll = repository.getAll();
  assert.equal(repository.getById('tyz').isCurrent, true);
  assert.equal(repository.getByName('允熙官方-zlm-外网').isCurrent, false);

  writeState(proxyLiveState('zlm', { contract: { key: 'never-expose-contract-key' } }));
  const current = repository.getCurrent();
  assert.equal(current.id, 'zlm');
  assert.equal(current.isCurrent, true);
  assert.notEqual(repository.getAll(), legacyAll);
  assert.deepEqual(repository.getAll().filter(item => item.isCurrent).map(item => item.id), ['zlm']);
  assert.equal(repository.getById('tyz').isCurrent, false);
  assert.equal(repository.getById('zlm').isCurrent, true);
  assert.equal(repository.getByName('允熙官方 -tyz-外网').isCurrent, false);
  assert.equal(repository.getByName('允熙官方-zlm-外网').isCurrent, true);
  assert.doesNotMatch(JSON.stringify(current), /never-expose-contract-key/);
  assert.deepEqual(database.prepare("SELECT id FROM providers WHERE app_type = 'codex' AND is_current = 1").all().map(row => row.id), ['tyz']);
});

test('live-route-only switches invalidate change tokens and cached current flags without changing SQLite', t => {
  const { repository, writeState } = liveStateRepository(t);
  const databaseStat = fs.statSync(repository.databasePath);
  writeState(proxyLiveState('zlm'));
  const token = repository.getChangeToken();
  const snapshot = repository.getAll();
  const current = repository.getCurrent();
  assert.equal(repository.getAll(), snapshot);
  assert.equal(repository.getCurrent(), current);
  writeState(proxyLiveState('zlm', { contract: { version: 1, key: 'changed-contract' } }));
  assert.notEqual(repository.getChangeToken(), token);
  assert.equal(repository.getAll(), snapshot, 'unrelated live-state edits must not rebuild Hub providers');
  assert.equal(repository.getCurrent(), current);

  const nextToken = repository.getChangeToken();
  writeState(proxyLiveState('tyz'));
  assert.notEqual(repository.getChangeToken(), nextToken);
  assert.notEqual(repository.getAll(), snapshot);
  assert.equal(repository.getCurrent().id, 'tyz');
  assert.deepEqual(repository.getAll().filter(item => item.isCurrent).map(item => item.id), ['tyz']);
  assert.equal(fs.statSync(repository.databasePath).mtimeMs, databaseStat.mtimeMs);

  writeState(proxyLiveState('zlm'));
  assert.equal(repository.getCurrent().id, 'zlm');
  fs.rmSync(repository.liveStatePath);
  assert.equal(repository.getCurrent().id, 'tyz');
  assert.deepEqual(repository.getAll().filter(item => item.isCurrent).map(item => item.id), ['tyz']);
});

test('missing, unsupported, detached, invalid and non-Codex live routes retain the legacy selection', t => {
  const { repository, writeState } = liveStateRepository(t);
  const cases = [
    proxyLiveState('zlm', { mode: 'direct' }),
    proxyLiveState('zlm', { attached: false }),
    { ...proxyLiveState('zlm'), version: 2 },
    { version: 1, apps: { claude: proxyLiveState('zlm').apps.codex } },
    proxyLiveState('missing-provider'),
    proxyLiveState('claude-only'),
    proxyLiveState({ id: 'zlm' }),
    proxyLiveState('zlm\n'),
    '{"version":',
    ' '.repeat(65_537),
  ];
  for (const state of cases) {
    writeState(proxyLiveState('zlm'));
    assert.equal(repository.getCurrent().id, 'zlm');
    writeState(state);
    assert.equal(repository.getCurrent().id, 'tyz');
    assert.deepEqual(repository.getAll().filter(item => item.isCurrent).map(item => item.id), ['tyz']);
  }
});

test('repository reopening retains the live route and read-only database access', t => {
  const { repository, database, writeState } = liveStateRepository(t);
  writeState(proxyLiveState('zlm'));
  assert.equal(repository.getCurrent().id, 'zlm');
  repository.close();
  database.prepare("UPDATE providers SET name = 'Updated zlm' WHERE id = 'zlm'").run();
  assert.equal(repository.getCurrent().name, 'Updated zlm');
  assert.throws(() => repository.database.exec("UPDATE providers SET is_current = 0"), /readonly/i);
});

test('provider rows bound public identifiers, URLs, and API keys', () => {
  const item = parseProviderRow({
    id: `provider\0${'x'.repeat(300)}`,
    name: `  Provider\n${'n'.repeat(300)}  `,
    website_url: `https://example.test/${'w'.repeat(3_000)}`,
    is_current: 1,
    settings_config: JSON.stringify({
      config: `base_url = "https://api.example.test/${'b'.repeat(3_000)}"`,
      auth: { OPENAI_API_KEY: 'k'.repeat(20_000) },
    }),
    meta: '{}',
  });

  assert.ok(item.id.length <= 160);
  assert.doesNotMatch(item.id, /\0/);
  assert.ok(item.name.length <= 160);
  assert.doesNotMatch(item.name, /[\r\n]/);
  assert.ok(item.websiteUrl.length <= 2_048);
  assert.ok(item.apiBaseUrl.length <= 2_048);
  assert.equal(item.apiKey.length, 16_384);
});

test('provider database scans cap rows and prefilter exact credential matches', () => {
  const prepared = [];
  const calls = [];
  const database = {
    prepare(sql) {
      prepared.push(sql);
      return {
        all(...args) { calls.push(args); return []; },
      };
    },
    close() {},
  };
  const repository = new ProviderRepository('test.db', {
    databaseFactory: () => database,
    statSync: () => ({ dev: 1, ino: 2, birthtimeMs: 3 }),
  });
  try {
    assert.deepEqual(repository.getAll(), []);
    assert.deepEqual(repository.getCredentialAppTypes('private-key'), []);
    assert.match(prepared[0], /LIMIT 513/);
    assert.match(prepared[0], /length\(settings_config\) <= 65536/);
    assert.equal((prepared[1].match(/instr\(settings_config, \?\) > 0/g) || []).length, 2);
    assert.match(prepared[1], /LIMIT 65/);
    assert.deepEqual(calls, [[], ['private-key', 'private-key']]);
  } finally {
    repository.close();
  }
});

test('provider database scans fail closed when row bounds overflow', () => {
  const database = {
    prepare(sql) {
      if (/WHERE app_type = 'codex'\s+ORDER BY/.test(sql)) {
        return { all: () => Array.from({ length: 513 }, () => ({})) };
      }
      return { all: () => Array.from({ length: 65 }, () => ({})) };
    },
    close() {},
  };
  const repository = new ProviderRepository('test.db', {
    databaseFactory: () => database,
    statSync: () => ({ dev: 1, ino: 2, birthtimeMs: 3 }),
  });
  try {
    assert.throws(() => repository.getAll(), /供应商数量超过安全上限 512/);
    assert.deepEqual(repository.getCredentialAppTypes('private-key'), ['unknown']);
  } finally {
    repository.close();
  }
});

test('recent request lookup lets SQLite choose the best available index', () => {
  const prepared = [];
  const calls = [];
  const database = {
    prepare(sql) {
      prepared.push(sql);
      return {
        all(providerId, limit) {
          calls.push([providerId, limit]);
          return [{
            model: 'gpt-5.6-sol',
            request_model: 'gpt-5.6-sol',
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 3,
            cache_creation_tokens: 0,
            total_cost_usd: '0.01',
            latency_ms: 1200,
            first_token_ms: 200,
            status_code: 200,
            created_at: 1_785_196_800,
          }];
        },
      };
    },
    close() {},
  };
  const repository = new ProviderRepository('test.db', {
    databaseFactory: () => database,
    statSync: () => ({ dev: 1, ino: 2, birthtimeMs: 3 }),
  });

  try {
    const rows = repository.getRecentRequests('provider-one', 500);
    assert.equal(prepared.length, 1);
    assert.doesNotMatch(prepared[0], /INDEXED\s+BY/i);
    assert.match(prepared[0], /ORDER BY created_at DESC, request_id DESC/);
    assert.deepEqual(calls, [['provider-one', 50]]);
    assert.equal(rows[0].statusCode, 200);
  } finally {
    repository.close();
  }
});
