import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('host connects targets before starting the initial usage refresh', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('async function loop()'), source.indexOf('function shutdown('));
  const targetSync = loop.indexOf('await requestTargetSync()');
  const usageRefresh = loop.indexOf('requestUsageRefresh(false, true)');

  assert.ok(targetSync >= 0, 'startup must synchronize targets');
  assert.ok(usageRefresh > targetSync, 'initial usage refresh must start after target synchronization');
  assert.doesNotMatch(loop, /await requestUsageRefresh\(false, false\)/, 'quota I/O must not block target injection');
});

test('v2 current-provider quota is sourced only from Balance Hub', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('async function refreshUsage('), source.indexOf('async function syncTargets()'));

  assert.match(refresh, /hubService\.refreshProvider\(provider\.id\)/);
  assert.match(refresh, /hubItemToUsagePayload\(provider, item\)/);
  assert.match(source, /new BrowserCallbackBroker\(\)/);
  assert.doesNotMatch(source, /import \{ queryUsage \}/);
  assert.doesNotMatch(source, /EdgeSession|hub-edge-profile/);
  assert.doesNotMatch(refresh, /provider\.usage\?\.enabled/);
});

test('every status write preserves page connectivity fields', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const writeStatus = source.slice(source.indexOf('function writeStatus('), source.indexOf('function safeMessage('));

  assert.match(writeStatus, /connectedPages:\s*sessions\.size/);
  assert.match(writeStatus, /connectionError:\s*lastConnectionError/);
});

test('host watches for explicit remount requests from the launcher', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  assert.match(source, /function startControlWatcher\(/);
  assert.match(source, /remount\.request/);
  assert.match(source, /requestTargetSync\(\)/);
});

test('host schedules quota refreshes and only polls database metadata in the fallback loop', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('async function loop()'), source.indexOf('function shutdown('));

  assert.match(source, /function scheduleUsageRefresh\(/);
  assert.match(loop, /repository\.getChangeToken\(\)/);
  assert.doesNotMatch(loop, /requestUsageRefresh\(false, true\),\s*requestTargetSync/);
});

test('host backs off healthy fallback work and writes low-frequency status heartbeats', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('async function loop()'), source.indexOf('function shutdown('));

  assert.match(source, /const DEGRADED_FALLBACK_POLL_MS = 30_000;/);
  assert.match(source, /const HEALTHY_FALLBACK_POLL_MS = 300_000;/);
  assert.match(source, /const STATUS_HEARTBEAT_MS = 300_000;/);
  assert.match(source, /function getFallbackPollMs\(\)/);
  assert.match(loop, /await waitForFallbackPoll\(getFallbackPollMs\(\)\)/);
  assert.match(loop, /Date\.now\(\) - lastStatusWriteAt >= STATUS_HEARTBEAT_MS/);
  assert.match(loop, /startDatabaseWatcher\(\)/);
  assert.match(loop, /startControlWatcher\(\)/);
});

test('host cleans excluded auxiliary targets once without retaining a session', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('async function syncTargets()'), source.indexOf('async function broadcastPayload()'));

  assert.match(sync, /listCodexTargets\(args\.port, \{ includeAuxiliary: true \}\)/);
  assert.match(sync, /discoveredTargets\.filter\(isCodexTargetCandidate\)/);
  assert.match(sync, /discoveredTargets\.filter\(isCodexAuxiliaryTarget\)/);
  assert.match(sync, /cleanedAuxiliaryTargetIds\.has\(target\.id\)/);
  assert.match(sync, /await disposeTargetInjector\(client, UPDATE_GLOBAL\)/);
  assert.match(sync, /client\.close\(\)/);
});

test('database watcher coalesces file bursts with a low-latency debounce', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
  const debounce = source.match(/const DATABASE_WATCH_DEBOUNCE_MS = (\d+);/);
  const watcher = source.slice(source.indexOf('function startDatabaseWatcher()'), source.indexOf('function startControlWatcher()'));

  assert.ok(debounce, 'database watcher debounce must remain explicit');
  assert.ok(Number(debounce[1]) >= 75 && Number(debounce[1]) <= 150, 'debounce should coalesce WAL bursts without adding visible delay');
  assert.match(watcher, /if \(databaseWatchTimer\) clearTimeout\(databaseWatchTimer\)/);
  assert.match(watcher, /}, DATABASE_WATCH_DEBOUNCE_MS\);/);
});

test('host exits through an event-driven three-second CDP disconnect guard', () => {
  const source = fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');

  assert.match(source, /const CDP_DISCONNECT_GRACE_MS = 3_000;/);
  assert.match(source, /new CdpDisconnectGuard\(\{/);
  assert.match(source, /onDisconnect:\s*\(\) => cdpDisconnectGuard\.notifyDisconnected\(\)/);
  assert.match(source, /verifyConnection:\s*verifyCdpConnection/);
  assert.match(source, /onExpired:\s*\(\) => shutdown\('CDP disconnected'\)/);
  assert.doesNotMatch(source, /setInterval\([^)]*(?:process|pid|ChatGPT)/i);
});
