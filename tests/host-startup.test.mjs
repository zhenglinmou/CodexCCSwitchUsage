import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function hostSource() {
  return fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
}

test('host starts Balance Hub before its first one-shot main-page injection', () => {
  const source = hostSource();
  const loop = source.slice(source.indexOf('async function loop()'), source.indexOf('function shutdown('));
  const hubStart = loop.indexOf('await hubServer.start()');
  const targetSync = loop.indexOf('await requestTargetSync({ audit: true })');

  assert.ok(hubStart >= 0, 'Balance Hub must start first');
  assert.ok(targetSync > hubStart, 'initial one-shot injection must run after Hub startup');
  assert.ok(loop.indexOf('requestCurrentProviderRefresh(false, true)') > targetSync, 'current CCSwitch provider may start its configured timer after injection');
});

test('v2 current-provider quota is sourced only from Balance Hub', () => {
  const source = hostSource();
  const refresh = source.slice(source.indexOf('async function refreshCurrentProvider('), source.indexOf('async function syncTargets('));

  assert.match(refresh, /hubService\.refreshProvider\(provider\.id\)/);
  assert.match(refresh, /hubItemToUsagePayload\(provider, item\)/);
  assert.match(source, /new BrowserCallbackBroker\(\)/);
  assert.doesNotMatch(source, /import \{ queryUsage \}/);
  assert.doesNotMatch(source, /EdgeSession|hub-edge-profile/);
  assert.doesNotMatch(refresh, /provider\.usage\?\.enabled/);
});

test('host owns no browser-wide discovery or long-lived target sessions', () => {
  const source = hostSource();

  assert.doesNotMatch(source, /getBrowserWebSocketUrl|TargetDiscovery|CdpDisconnectGuard|TargetSession/);
  assert.doesNotMatch(source, /Target\.setDiscoverTargets|Runtime\.enable|Runtime\.addBinding/);
  assert.doesNotMatch(source, /const sessions = new Map\(\)/);
  assert.doesNotMatch(source, /startTargetDiscovery|verifyCdpConnection|broadcastPayload/);
  assert.match(source, /installTargetOnce/);
});

test('target synchronization uses only HTTP snapshots and one-shot primary-page installs', () => {
  const source = hostSource();
  const sync = source.slice(source.indexOf('async function syncTargets('), source.indexOf('function requestTargetSync('));

  assert.match(sync, /let allTargets = await listCdpTargets\(args\.port\)/);
  assert.match(sync, /isCodexTargetCandidate\(target\)/);
  assert.match(sync, /hasAuxiliaryPageTargets\(allTargets\)/);
  assert.match(sync, /await settleTargetOperations\(targetActions,/);
  assert.match(sync, /installTargetOnce\(/);
  assert.match(sync, /const targetIdentityChanged =/);
  assert.ok((sync.match(/listCdpTargets\(args\.port\)/g) || []).length >= 2);
  assert.doesNotMatch(sync, /includeAuxiliary|auxiliaryTargets|cleanupAuxiliaryTarget|disposeTargetInjector/);
});

test('page actions are consumed from target titles without Runtime bindings', () => {
  const source = hostSource();

  assert.match(source, /decodePageActionMarker\(target\.title\)/);
  assert.match(source, /action\.action === 'refresh'/);
  assert.match(source, /action\.action === 'open-hub'/);
  assert.doesNotMatch(source, /bindingCalled|REFRESH_BINDING|HUB_BINDING/);
});

test('an injector audit deferred by Browse remains pending until a safe target snapshot', () => {
  const source = hostSource();
  const request = source.slice(source.indexOf('function requestTargetSync('), source.indexOf('function startDatabaseWatcher('));

  assert.match(request, /const currentAudit = targetAuditPending;/);
  assert.match(request, /catch \(error\) \{[\s\S]*targetAuditPending \|\|= currentAudit;/);
});

test('a failed injector audit never accelerates maintenance beyond the one-second action poll', () => {
  const source = hostSource();
  const delay = source.slice(source.indexOf('function nextMaintenanceDelay('), source.indexOf('async function loop('));

  assert.match(delay, /const injectorAuditDelay = targetAuditPending\s*\? PAGE_ACTION_POLL_MS\s*: until\(lastInjectorAuditAt, INJECTOR_AUDIT_MS\)/);
  assert.match(delay, /controlWatcher \? injectorAuditDelay : WATCHER_RETRY_MS/);
  assert.match(delay, /PAGE_ACTION_POLL_MS,\s*injectorAuditDelay,/);
});

test('failed one-shot installs use keyed bounded backoff without delaying page-action snapshots', () => {
  const source = hostSource();
  const sync = source.slice(source.indexOf('async function syncTargets('), source.indexOf('function requestTargetSync('));
  const request = source.slice(source.indexOf('function requestTargetSync('), source.indexOf('function syncHubProviders('));

  assert.match(source, /new KeyedBackoff\(\)/);
  assert.match(sync, /const targetSignature = \[\.\.\.targetIds\]\.sort\(\)\.join\('\|'\)/);
  assert.match(sync, /pendingActions\.length === 0 && !targetInstallBackoff\.isReady\(targetSignature\)/);
  assert.match(sync, /targetInstallBackoff\.fail\(targetSignature\)/);
  assert.match(sync, /targetInstallBackoff\.reset\(\)/);
  assert.match(request, /if \(outcome\?\.deferred\) targetAuditPending = true/);
  assert.match(source, /targetInstallRetryMs: targetInstallBackoff\.remainingMs\(\)/);
});

test('status reports mounted primary pages while event-driven CDP remains disabled', () => {
  const source = hostSource();
  const writeStatus = source.slice(source.indexOf('function writeStatus('), source.indexOf('function safeMessage('));

  assert.match(writeStatus, /eventDrivenTargets:\s*false/);
  assert.match(writeStatus, /connectedPages:\s*mountedPages/);
  assert.match(writeStatus, /connectionError:\s*lastConnectionError/);
});

test('host watches explicit remount requests from the launcher', () => {
  const source = hostSource();

  assert.match(source, /function startControlWatcher\(/);
  assert.match(source, /remount\.request/);
  assert.match(source, /requestTargetSync\(\{ audit: true \}\)/);
});

test('host schedules only the current CCSwitch provider and leaves Hub providers manual', () => {
  const source = hostSource();
  const loop = source.slice(source.indexOf('async function loop()'), source.indexOf('function shutdown('));

  assert.match(source, /const CURRENT_PROVIDER_REFRESH_MS = 300_000;/);
  assert.match(source, /const WATCHER_RETRY_MS = 1_000;/);
  assert.match(source, /const PAGE_ACTION_POLL_MS = 1_000;/);
  assert.match(source, /const DATABASE_AUDIT_MS = 60_000;/);
  assert.match(source, /const STATUS_HEARTBEAT_MS = 300_000;/);
  assert.match(loop, /repository\.getChangeToken\(\)/);
  assert.match(loop, /databaseAuditDue/);
  assert.match(loop, /requestTargetSync\(\{ audit: auditDue \|\| providersChanged \}\)/);
  assert.doesNotMatch(source, /provider\.usage\?\.autoQueryInterval/);
  assert.match(source, /hubService\.refreshProvider\(provider\.id\)/);
  assert.match(loop, /providersChanged \? requestCurrentProviderRefresh\(false, true\)/);
  assert.match(source, /item\.action\.action === 'refresh'[\s\S]*await refreshCurrentProvider\(true\)/);
  assert.doesNotMatch(source, /hubService\.refreshAll\(\)|refreshBrowserProviders|observeBrowserCompanion/);
});

test('host keeps only the bounded page-title action poll for responsive composer actions', () => {
  const source = hostSource();

  assert.match(source, /const PAGE_ACTION_POLL_MS = 1_000/);
  assert.match(source, /decodePageActionMarker|lastActionSignature/);
  assert.doesNotMatch(source, /actionEndpoint|onAction:\s*handlePageAction/);
});

test('current-provider scheduling resumes from the cached query timestamp after a host reload', () => {
  const source = hostSource();

  assert.match(source, /const cachedQueryAt = Date\.parse\(String\(lastPayload\.updatedAt \|\| ''\)\)/);
  assert.match(source, /let lastQueryAt = Number\.isFinite\(cachedQueryAt\) \? Math\.min\(Date\.now\(\), cachedQueryAt\) : 0/);
});

test('host never refreshes provider balances merely because the browser companion reconnects', () => {
  const source = hostSource();

  assert.doesNotMatch(source, /observeBrowserCompanion/);
  assert.doesNotMatch(source, /refreshBrowserProviders/);
  assert.doesNotMatch(source, /browserCompanionGeneration/);
});

test('database watcher coalesces file bursts with a low-latency debounce', () => {
  const source = hostSource();
  const debounce = source.match(/const DATABASE_WATCH_DEBOUNCE_MS = (\d+);/);
  const watcher = source.slice(source.indexOf('function startDatabaseWatcher()'), source.indexOf('function startControlWatcher()'));

  assert.ok(debounce, 'database watcher debounce must remain explicit');
  assert.ok(Number(debounce[1]) >= 75 && Number(debounce[1]) <= 150, 'debounce should coalesce WAL bursts without visible delay');
  assert.match(watcher, /if \(databaseWatchTimer\) clearTimeout\(databaseWatchTimer\)/);
  assert.match(watcher, /const providersChanged = syncHubProviders\(\)/);
  assert.match(watcher, /if \(providersChanged\) requestCurrentProviderRefresh\(false, true\)/);
  assert.match(watcher, /}, DATABASE_WATCH_DEBOUNCE_MS\);/);
});
