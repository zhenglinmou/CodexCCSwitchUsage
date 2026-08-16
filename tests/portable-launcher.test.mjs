import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildHostArguments,
  buildProxyEnvironment,
  findCodexRootProcess,
  hasLoopbackDebuggingAddress,
  parseLauncherArgs,
  parseProcessTable,
  remoteDebuggingPort,
} from '../scripts/launch.mjs';
import { inspectHostProcess } from '../scripts/stop-host.mjs';

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

test('portable launcher auto-discovers a non-default loopback CDP port and rejects external bindings', () => {
  const processes = parseProcessTable([
    '  90 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=53421 --remote-debugging-address=0.0.0.0',
    '  91 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=54873 --remote-debugging-address=127.0.0.1',
  ].join('\n'));

  assert.equal(remoteDebuggingPort(processes[1].commandLine), 54873);
  assert.equal(hasLoopbackDebuggingAddress(processes[0].commandLine), false);
  assert.equal(hasLoopbackDebuggingAddress(processes[1].commandLine), true);
  assert.equal(findCodexRootProcess(processes)?.pid, 91);
  assert.equal(findCodexRootProcess(processes, 53421), null);
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
    port: 0,
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

test('macOS all-instances discovery validates and returns each real plugin root', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-stop-roots-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const createRoot = (name, markerName = 'codex-ccswitch-usage') => {
    const root = path.join(directory, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: markerName }));
    fs.writeFileSync(path.join(root, 'src', 'host.mjs'), '');
    return root;
  };
  const firstRoot = createRoot('first root');
  const secondRoot = createRoot('second root');
  const unsafeRoot = createRoot('unsafe root', 'other-package');
  const processFor = (pid, root, port = 9334) => ({
    pid,
    commandLine: `node --no-warnings "${path.join(root, 'src', 'host.mjs')}" --port ${port} --runtime-dir "${path.join(root, 'private runtime')}"`,
  });

  const second = inspectHostProcess(processFor(202, secondRoot), {
    expectedHostPath: path.join(firstRoot, 'src', 'host.mjs'), port: 9334, allInstances: true,
  });
  assert.equal(second.root, secondRoot);
  assert.equal(second.runtimeDir, path.join(secondRoot, 'private runtime'));
  assert.equal(inspectHostProcess(processFor(202, secondRoot), {
    expectedHostPath: path.join(firstRoot, 'src', 'host.mjs'), port: 9334, allInstances: false,
  }), null);
  assert.equal(inspectHostProcess(processFor(303, unsafeRoot), { port: 9334, allInstances: true }), null);
  assert.equal(inspectHostProcess(processFor(404, secondRoot, 9444), { port: 9334, allInstances: true }), null);

  const oversizedRoot = createRoot('oversized root');
  fs.truncateSync(path.join(oversizedRoot, 'package.json'), 65_537);
  assert.equal(inspectHostProcess(processFor(505, oversizedRoot), { port: 9334, allInstances: true }), null);
});
