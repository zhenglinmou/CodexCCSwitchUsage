import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCodexHomeDir,
  getDefaultDatabasePath,
  getHomeDir,
  getOpenCommand,
  openExternalUrl,
} from '../src/platform.mjs';

test('home directory prefers the native environment variable for each platform', () => {
  assert.equal(
    getHomeDir({ USERPROFILE: 'C:\\Users\\demo', HOME: '/Users/demo' }, 'win32'),
    'C:\\Users\\demo',
  );
  assert.equal(
    getHomeDir({ USERPROFILE: 'C:\\Users\\demo', HOME: '/Users/demo' }, 'darwin'),
    '/Users/demo',
  );
  assert.equal(getHomeDir({ HOME: '/Users/demo' }, 'darwin'), '/Users/demo');
});

test('default CCSwitch and Codex paths work with a macOS HOME', () => {
  const env = { HOME: '/Users/demo' };
  assert.equal(getDefaultDatabasePath(env, '/workspace', 'darwin'), '/Users/demo/.cc-switch/cc-switch.db');
  assert.equal(getCodexHomeDir(env, 'darwin'), '/Users/demo/.codex');
});

test('external URL commands use the native desktop opener', () => {
  assert.deepEqual(getOpenCommand('darwin'), { command: 'open', args: [] });
  assert.deepEqual(getOpenCommand('win32'), { command: 'explorer.exe', args: [] });
  assert.deepEqual(getOpenCommand('linux'), { command: 'xdg-open', args: [] });
});

test('opening a Hub URL does not add Windows-only spawn options on macOS', () => {
  const calls = [];
  const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const result = openExternalUrl('http://127.0.0.1:17891/hub/test', {
    platform: 'darwin',
    spawnFn: (...args) => {
      calls.push(args);
      return child;
    },
  });

  assert.equal(result, child);
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(calls, [[
    'open',
    ['http://127.0.0.1:17891/hub/test'],
    { detached: true, stdio: 'ignore' },
  ]]);
});
