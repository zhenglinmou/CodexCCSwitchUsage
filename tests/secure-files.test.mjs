import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  secureAtomicWriteFile,
  secureAtomicWriteFileSync,
  secureCreateFileSync,
  secureMkdirSync,
  secureOpenAppendSync,
} from '../src/secure-files.mjs';

test('private runtime helpers write atomically and enforce POSIX owner-only modes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-private-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  const state = path.join(runtime, 'state.json');
  const log = path.join(runtime, 'host.log');

  secureMkdirSync(runtime);
  secureAtomicWriteFileSync(state, '{"value":1}', { encoding: 'utf8' });
  await secureAtomicWriteFile(state, '{"value":2}', { encoding: 'utf8' });
  assert.equal(secureCreateFileSync(path.join(runtime, 'create-once'), 'first', { encoding: 'utf8' }), true);
  assert.equal(secureCreateFileSync(path.join(runtime, 'create-once'), 'second', { encoding: 'utf8' }), false);
  assert.equal(fs.readFileSync(path.join(runtime, 'create-once'), 'utf8'), 'first');
  const candidates = Array.from({ length: 12 }, (_, index) => `value-${index}`);
  await Promise.all(candidates.map(value => secureAtomicWriteFile(state, value, { encoding: 'utf8' })));
  const descriptor = secureOpenAppendSync(log);
  fs.writeSync(descriptor, 'bounded log\n');
  fs.closeSync(descriptor);

  assert.ok(candidates.includes(fs.readFileSync(state, 'utf8')));
  assert.equal(fs.existsSync(`${state}.tmp`), false);
  assert.deepEqual(fs.readdirSync(runtime).filter(name => name.endsWith('.tmp')), []);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
    assert.equal(fs.statSync(state).mode & 0o777, 0o600);
    assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  }
});
