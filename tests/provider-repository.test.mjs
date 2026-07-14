import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRepository } from '../src/provider-repository.mjs';

function providerRow(overrides = {}) {
  return {
    id: 'provider-1',
    name: 'Provider One',
    website_url: 'https://example.com',
    settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'key' }, config: 'base_url="https://api.example.com"' }),
    meta: JSON.stringify({ usage_script: { enabled: true, code: '({})' } }),
    ...overrides,
  };
}

test('provider repository reuses its database, prepared statements and parsed rows', () => {
  let identity = 1;
  let row = providerRow();
  let opens = 0;
  let prepares = 0;
  const databases = [];
  const databaseFactory = () => {
    opens += 1;
    const database = {
      closed: false,
      prepare() {
        prepares += 1;
        return { get: () => row };
      },
      close() { this.closed = true; },
    };
    databases.push(database);
    return database;
  };
  const repository = new ProviderRepository('fake.db', {
    databaseFactory,
    statSync: () => ({ dev: 1, ino: identity, birthtimeMs: identity }),
  });

  const first = repository.getCurrent();
  const second = repository.getCurrent();
  assert.equal(first, second, 'unchanged raw database fields should reuse the parsed provider object');
  assert.equal(opens, 1);
  assert.equal(prepares, 1);

  row = providerRow({ name: 'Provider Renamed' });
  const changed = repository.getCurrent();
  assert.notEqual(changed, first);
  assert.equal(changed.name, 'Provider Renamed');
  assert.equal(opens, 1, 'normal database writes must keep the existing connection');

  identity = 2;
  repository.getCurrent();
  assert.equal(opens, 2, 'replacing the database file must reopen the connection');
  assert.equal(databases[0].closed, true);
  repository.close();
  assert.equal(databases[1].closed, true);
});

test('provider repository change token includes sqlite sidecar files', () => {
  const stats = new Map([
    ['test.db', { dev: 1, ino: 2, size: 10, mtimeMs: 100 }],
    ['test.db-wal', { dev: 1, ino: 3, size: 20, mtimeMs: 200 }],
  ]);
  const repository = new ProviderRepository('test.db', {
    statSync: filename => {
      if (!stats.has(filename)) throw new Error('missing');
      return stats.get(filename);
    },
  });

  const first = repository.getChangeToken();
  stats.set('test.db-wal', { dev: 1, ino: 3, size: 21, mtimeMs: 201 });
  const second = repository.getChangeToken();

  assert.notEqual(first, second);
  assert.match(first, /missing$/);
});
