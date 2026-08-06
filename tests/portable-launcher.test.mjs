import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHostArguments,
  buildProxyEnvironment,
  findCodexRootProcess,
  parseLauncherArgs,
  parseProcessTable,
} from '../scripts/launch.mjs';

test('macOS process table parsing keeps the exact root command line', () => {
  const processes = parseProcessTable([
    '  91 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9334 --no-first-run',
    '  92 /Applications/Codex.app/Contents/MacOS/Codex --type=renderer --remote-debugging-port=9334',
    '  93 /usr/local/bin/node /workspace/src/host.mjs --codex-pid 91',
  ].join('\n'));

  assert.deepEqual(processes[0], {
    pid: 91,
    commandLine: '/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9334 --no-first-run',
    name: 'Codex',
  });
  assert.equal(processes.length, 3);
});

test('macOS Codex root selection ignores renderer processes', () => {
  const processes = parseProcessTable([
    '  91 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9334 --no-first-run',
    '  92 /Applications/Codex.app/Contents/MacOS/Codex --type=renderer --remote-debugging-port=9334',
  ].join('\n'));

  assert.equal(findCodexRootProcess(processes, 9334)?.pid, 91);
});

test('portable launcher passes explicit paths and root PID to the host', () => {
  assert.deepEqual(buildHostArguments({
    root: '/workspace',
    port: 9334,
    codexPid: 91,
    runtimeDir: '/workspace/runtime',
    databasePath: '/Users/demo/.cc-switch/cc-switch.db',
    platform: 'darwin',
  }), [
    '--use-env-proxy',
    '--no-warnings',
    '--experimental-sqlite',
    '/workspace/src/host.mjs',
    '--port', '9334',
    '--codex-pid', '91',
    '--runtime-dir', '/workspace/runtime',
    '--database', '/Users/demo/.cc-switch/cc-switch.db',
  ]);
});

test('portable launcher accepts a writable runtime directory outside the app bundle', () => {
  assert.deepEqual(parseLauncherArgs([
    '--install-root', '/Applications/CodexCCSwitchUsage.app/Contents/Resources/app',
    '--runtime-dir', '/Users/demo/Library/Application Support/CodexCCSwitchUsage/runtime',
    '--database', '/Users/demo/.cc-switch/cc-switch.db',
  ]), {
    installRoot: '/Applications/CodexCCSwitchUsage.app/Contents/Resources/app',
    port: 9334,
    codexPid: 0,
    runtimeDir: '/Users/demo/Library/Application Support/CodexCCSwitchUsage/runtime',
    databasePath: '/Users/demo/.cc-switch/cc-switch.db',
  });
});

test('macOS proxy discovery keeps loopback traffic outside the proxy', () => {
  const environment = buildProxyEnvironment({
    platform: 'darwin',
    env: { NO_PROXY: 'example.test' },
    execFileSyncFn: () => [
      'HTTPEnable : 1',
      'HTTPProxy : 127.0.0.1',
      'HTTPPort : 7890',
      'HTTPSEnable : 0',
    ].join('\n'),
  });

  assert.equal(environment.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.deepEqual(environment.NO_PROXY.split(','), ['example.test', '127.0.0.1', 'localhost', '::1']);
});
