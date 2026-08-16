import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function hostSource() {
  return fs.readFileSync(new URL('../src/host.mjs', import.meta.url), 'utf8');
}

test('host starts Balance Hub before its first one-shot main-page injection', () => {
  const source = hostSource();
  const loop = source.slice(source.indexOf('async function loop()'), source.indexOf('function shutdown('));
  const hubStart = loop.indexOf('await ensureHubServer(true)');
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

test('host exits completely when its exact Codex root process exits', () => {
  const source = hostSource();
  const shutdown = source.slice(source.indexOf('function shutdown('), source.indexOf("process.on('SIGINT'"));

  assert.match(source, /if \(!isProcessAlive\(args\.codexPid\)\) throw/);
  assert.match(source, /new ProcessExitMonitor\(\{/);
  assert.match(source, /processId: args\.codexPid/);
  assert.match(source, /intervalMs: CODEX_PROCESS_POLL_MS/);
  assert.match(source, /onExit: \(\) => shutdown\('Codex root process exited'\)/);
  assert.match(shutdown, /codexProcessMonitor\?\.close\(\)/);
  assert.match(shutdown, /hubServer\.close\(\)/);
  assert.match(shutdown, /browserBroker\.close\(\)/);
  assert.match(shutdown, /repository\.close\(\)/);
  assert.match(shutdown, /const forceExitTimer = setTimeout\(\(\) => process\.exit\(0\), 750\)/);
  assert.match(shutdown, /process\.exit\(0\)/);
});

test('target synchronization uses only HTTP snapshots and one-shot primary-page installs', () => {
  const source = hostSource();
  const sync = source.slice(source.indexOf('async function syncTargets('), source.indexOf('function requestTargetSync('));

  assert.match(sync, /const allTargets = await listCdpTargets\(args\.port\)/);
  assert.match(sync, /allTargets\.filter\(target => isCodexTargetCandidate\(target\) && target\.webSocketDebuggerUrl\)/);
  assert.match(sync, /await settleTargetOperations\(installTargets,/);
  assert.match(sync, /installTargetOnce\(/);
  assert.match(sync, /const targetIdentityChanged =/);
  assert.equal((sync.match(/listCdpTargets\(args\.port\)/g) || []).length, 1, 'an accepted action must not force a redundant target snapshot');
  assert.doesNotMatch(sync, /includeAuxiliary|auxiliaryTargets|cleanupAuxiliaryTarget|disposeTargetInjector/);
});

test('page actions are consumed from target titles without Runtime bindings', () => {
  const source = hostSource();
  const sync = source.slice(source.indexOf('async function syncTargets('), source.indexOf('function requestTargetSync('));

  assert.match(source, /decodePageActionQueue\(target\.title\)/);
  assert.match(sync, /acknowledgePageAction\(target, target\.title\)/);
  assert.match(sync, /action\.action === 'refresh'[\s\S]*requestCurrentProviderRefresh\(true, true\)/);
  assert.match(sync, /action\.action === 'open-hub'[\s\S]*openHubFromAction\(\)/);
  assert.doesNotMatch(sync, /await refreshCurrentProvider\(true\)/);
  assert.ok(sync.indexOf('acknowledgePageAction(target, target.title)') < sync.indexOf('requestCurrentProviderRefresh(true, true)'), 'the exact marker must be acknowledged before slow network work is queued');
  assert.doesNotMatch(source, /bindingCalled|REFRESH_BINDING|HUB_BINDING/);
});

test('queued current-provider refreshes inject only the final coalesced result', () => {
  const source = hostSource();
  const refresh = source.slice(source.indexOf('function requestCurrentProviderRefresh('), source.indexOf('function openHubFromAction('));

  assert.match(refresh, /if \(currentProviderRefreshPending\)[\s\S]*currentProviderRefreshInjectPending = true/);
  assert.match(refresh, /else await requestTargetSync\(\{ audit: true \}\)/);
  assert.match(refresh, /currentProviderQueryActive = true[\s\S]*currentProviderQueryActive = false/);
  assert.match(source, /if \(currentProviderQueryActive\) return \{ installed: false, deferred: audit \|\| targetIdentityChanged \}/);
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
  assert.match(delay, /pageActionPollDelay,\s*injectorAuditDelay,/);
});

test('failed one-shot installs use keyed bounded backoff without delaying page-action snapshots', () => {
  const source = hostSource();
  const sync = source.slice(source.indexOf('async function syncTargets('), source.indexOf('function requestTargetSync('));
  const request = source.slice(source.indexOf('function requestTargetSync('), source.indexOf('function syncHubProviders('));

  assert.match(source, /new KeyedBackoff\(\)/);
  assert.match(sync, /const targetSignature = \[\.\.\.targetIds\]\.sort\(\)\.join\('\|'\)/);
  assert.match(sync, /markedActions\.length === 0 && !targetInstallBackoff\.isReady\(targetSignature\)/);
  assert.match(sync, /targetInstallBackoff\.fail\(targetSignature\)/);
  assert.match(sync, /targetInstallBackoff\.reset\(\)/);
  assert.match(sync, /if \(actionAccepted\) targetInstallBackoff\.reset\(\)/);
  assert.match(request, /if \(outcome\?\.deferred\) targetAuditPending = true/);
  assert.match(source, /targetInstallRetryMs: targetInstallBackoff\.remainingMs\(\)/);
});

test('database changes refresh a remote recent-request snapshot instead of leaving it stale', () => {
  const source = hostSource();
  const watcher = source.slice(source.indexOf('function startDatabaseWatcher()'), source.indexOf('function startControlWatcher()'));

  assert.match(source, /function shouldRefreshRemoteRecentRequests\(\)/);
  assert.match(source, /requestRecentRequestsRefresh\(\)/);
  assert.match(watcher, /syncRecentRequests\(\);[\s\S]*shouldRefreshRemoteRecentRequests\(\)[\s\S]*scheduleRemoteRecentRequestsRefresh\(\)/);
});

test('database-triggered remote recent-request refreshes are debounced', () => {
  const source = hostSource();
  const watcher = source.slice(source.indexOf('function startDatabaseWatcher()'), source.indexOf('function startControlWatcher()'));

  assert.match(source, /const REMOTE_RECENT_REQUEST_REFRESH_DEBOUNCE_MS = 750;/);
  assert.match(source, /function scheduleRemoteRecentRequestsRefresh\(\)/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*requestRecentRequestsRefresh\(\)/);
  assert.match(watcher, /scheduleRemoteRecentRequestsRefresh\(\)/);
});

test('recent request status code zero is normalized as unknown rather than failure', () => {
  const source = hostSource();
  const recent = source.slice(source.indexOf('function normalizedRecentRequest('), source.indexOf('function updateRecentRequestsState('));

  assert.match(recent, /const parsedStatusCode = optionalInteger\(item\?\.statusCode\);/);
  assert.match(recent, /const statusCode = parsedStatusCode > 0 \? parsedStatusCode : null;/);
});

test('status reports mounted primary pages while event-driven CDP remains disabled', () => {
  const source = hostSource();
  const writeStatus = source.slice(source.indexOf('function writeStatus('), source.indexOf('function safeMessage('));

  assert.match(writeStatus, /eventDrivenTargets:\s*false/);
  assert.match(writeStatus, /connectedPages:\s*mountedPages/);
  assert.match(writeStatus, /connectionError:\s*lastConnectionError/);
});

test('status and usage-cache writes are coalesced and remain non-fatal after transient file errors', () => {
  const source = hostSource();
  const usageCache = source.slice(source.indexOf('function writeUsageCache('), source.indexOf('let cachedUsage ='));
  const writeStatus = source.slice(source.indexOf('function writeStatus('), source.indexOf('function safeMessage('));

  assert.match(usageCache, /try \{[\s\S]*secureAtomicWriteFileSync[\s\S]*return true/);
  assert.match(usageCache, /catch \(error\) \{[\s\S]*lastUsageCacheError = safeMessage\(error\)[\s\S]*return false/);
  assert.match(writeStatus, /hubService\.getSummary\(\)\.providers/);
  assert.match(writeStatus, /browserBroker\.isConnected\(\)/);
  assert.match(writeStatus, /const signature = JSON\.stringify\(\{ \.\.\.status, updatedAt: '' \}\)/);
  assert.match(writeStatus, /signature === lastStatusSignature[\s\S]*STATUS_HEARTBEAT_MS/);
  assert.match(writeStatus, /try \{[\s\S]*secureAtomicWriteFileSync[\s\S]*return true/);
  assert.match(writeStatus, /catch \{[\s\S]*return false/);
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
  assert.match(source, /const PAGE_ACTION_IDLE_POLL_MS = 2_500;/);
  assert.match(source, /const DATABASE_AUDIT_MS = 60_000;/);
  assert.match(source, /const STATUS_HEARTBEAT_MS = 300_000;/);
  assert.match(loop, /repository\.getChangeToken\(\)/);
  assert.match(loop, /databaseAuditDue/);
  assert.match(loop, /requestTargetSync\(\{ audit: auditDue \|\| providersChanged \|\| recentRequestsChanged \}\)/);
  assert.doesNotMatch(source, /provider\.usage\?\.autoQueryInterval/);
  assert.match(source, /hubService\.refreshProvider\(provider\.id\)/);
  assert.match(loop, /providersChanged \? requestCurrentProviderRefresh\(false, true\)/);
  assert.match(source, /action\.action === 'refresh'[\s\S]*requestCurrentProviderRefresh\(true, true\)/);
  assert.doesNotMatch(source, /hubService\.refreshAll\(\)|refreshBrowserProviders|observeBrowserCompanion/);
});

test('host keeps only the bounded page-title action poll for responsive composer actions', () => {
  const source = hostSource();

  assert.match(source, /const PAGE_ACTION_POLL_MS = 1_000/);
  assert.match(source, /const PAGE_ACTION_IDLE_POLL_MS = 2_500/);
  assert.match(source, /decodePageActionQueue|recentActionSignatures/);
  assert.doesNotMatch(source, /actionEndpoint|onAction:\s*handlePageAction/);
});

test('host backs off page-action polling while a mounted page is idle', () => {
  const source = hostSource();
  const delay = source.slice(source.indexOf('function nextMaintenanceDelay('), source.indexOf('async function loop('));

  assert.match(delay, /const pageActionPollDelay =/);
  assert.match(delay, /PAGE_ACTION_IDLE_POLL_MS/);
  assert.match(delay, /pageActionPollDelay/);
});

test('current-provider scheduling resumes from the cached query timestamp after a host reload', () => {
  const source = hostSource();

  assert.match(source, /const cachedQueryAt = Date\.parse\(String\(lastPayload\.updatedAt \|\| ''\)\)/);
  assert.match(source, /let lastQueryAt = Number\.isFinite\(cachedQueryAt\) \? Math\.min\(Date\.now\(\), cachedQueryAt\) : 0/);
});

test('current-provider configuration changes bypass the cached five-minute query interval', () => {
  const source = hostSource();
  const refresh = source.slice(source.indexOf('async function refreshCurrentProvider('), source.indexOf('function requestCurrentProviderRefresh('));

  assert.match(source, /function providerRefreshSignature\(provider\)/);
  assert.match(refresh, /const providerConfigurationChanged = providerSignature !== lastProviderSignature/);
  assert.match(refresh, /!providerConfigurationChanged && !due/);
  assert.match(refresh, /const syncResult = syncHubProviders\(\)/);
  assert.match(refresh, /providerRefreshSignature\(hubProvider\) !== providerSignature/);
  assert.doesNotMatch(refresh, /if \(!hubService\.findProvider\(provider\.id\)\) hubService\.syncProviders\(\)/);
  assert.match(refresh, /lastProviderSignature = providerSignature/);
});

test('database change tokens advance only after a successful provider sync', () => {
  const source = hostSource();
  const watcher = source.slice(source.indexOf('function startDatabaseWatcher()'), source.indexOf('function startControlWatcher()'));

  assert.match(watcher, /const nextDatabaseChangeToken = repository\.getChangeToken\(\)/);
  assert.match(watcher, /const syncResult = syncHubProviders\(\)/);
  assert.match(watcher, /if \(!syncResult\.succeeded\)/);
  assert.match(watcher, /databaseChangeToken = nextDatabaseChangeToken/);
  assert.ok(
    watcher.indexOf('databaseChangeToken = nextDatabaseChangeToken') > watcher.indexOf('if (!syncResult.succeeded)'),
    'the consumed token must be committed only after provider sync succeeds',
  );
});

test('host retries a failed Balance Hub listener without restarting Codex', () => {
  const source = hostSource();

  assert.match(source, /const HUB_RETRY_MS = 5_000/);
  assert.match(source, /async function ensureHubServer/);
  assert.match(source, /await ensureHubServer\(true\)/);
  assert.match(source, /ensureHubServer\(\)/);
  assert.match(source, /EADDRINUSE[\s\S]*拒绝启动第二个插件宿主/);
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
  assert.match(watcher, /const syncResult = syncHubProviders\(\)/);
  assert.match(watcher, /const recentRequestsChanged = syncRecentRequests\(\)/);
  assert.match(watcher, /if \(syncResult\.changed\) requestCurrentProviderRefresh\(false, true\)/);
  assert.match(watcher, /else if \(recentRequestsChanged\) requestTargetSync\(\{ audit: true \}\)/);
  assert.match(watcher, /}, DATABASE_WATCH_DEBOUNCE_MS\);/);
});

test('request-log changes push a bounded local history without refreshing provider balances', () => {
  const source = hostSource();
  const recent = source.slice(source.indexOf('function payloadWithRecentRequests('), source.indexOf('function wakeFallbackPoll('));
  const watcher = source.slice(source.indexOf('function startDatabaseWatcher()'), source.indexOf('function startControlWatcher()'));

  assert.match(source, /const RECENT_REQUEST_LIMIT = 10/);
  assert.match(recent, /repository\.getRecentRequests\(providerId, RECENT_REQUEST_LIMIT\)/);
  assert.match(recent, /const matches = Boolean\(providerId && providerId === recentRequestProviderId\)/);
  assert.match(recent, /recentRequests: matches \? recentRequests : \[\]/);
  assert.match(watcher, /else if \(recentRequestsChanged\) requestTargetSync\(\{ audit: true \}\)/);
  assert.doesNotMatch(watcher, /recentRequestsChanged[^\n]*requestCurrentProviderRefresh/);
  assert.match(source, /delete cachePayload\.recentRequests/);
});
