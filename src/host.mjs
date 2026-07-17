import fs from 'node:fs';
import path from 'node:path';
import { BrowserCallbackBroker } from './browser-callback-broker.mjs';
import { hasAuxiliaryPageTargets, isCodexTargetCandidate, listCdpTargets } from './cdp-client.mjs';
import { ProviderRepository } from './provider-repository.mjs';
import { HubServer } from './hub-server.mjs';
import { ProviderQueryEngine } from './hub-provider-adapters.mjs';
import { hubItemToUsagePayload, HubService } from './hub-service.mjs';
import { buildInjectorScript, INJECTOR_VERSION, UPDATE_GLOBAL } from './injector-script.mjs';
import { KeyedBackoff } from './keyed-backoff.mjs';
import { decodePageActionMarker } from './page-action-channel.mjs';
import { installTargetOnce, settleTargetOperations } from './target-session.mjs';

const DATABASE_WATCH_DEBOUNCE_MS = 100;
const CURRENT_PROVIDER_REFRESH_MS = 300_000;
const WATCHER_RETRY_MS = 1_000;
const PAGE_ACTION_POLL_MS = 1_000;
const DATABASE_AUDIT_MS = 60_000;
const INJECTOR_AUDIT_MS = 300_000;
const STATUS_HEARTBEAT_MS = 300_000;

function parseArgs(argv) {
  const result = { port: 9334, database: path.join(process.env.USERPROFILE, '.cc-switch', 'cc-switch.db'), runtimeDir: path.join(process.cwd(), 'runtime') };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--port') result.port = Number(value);
    if (argv[index] === '--database') result.database = value;
    if (argv[index] === '--runtime-dir') result.runtimeDir = value;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.runtimeDir, { recursive: true });
const statusPath = path.join(args.runtimeDir, 'status.json');
const pidPath = path.join(args.runtimeDir, 'host.pid');
const cachePath = path.join(args.runtimeDir, 'usage-cache.json');
const repository = new ProviderRepository(args.database);
const browserBroker = new BrowserCallbackBroker();
const hubQueryEngine = new ProviderQueryEngine(repository, browserBroker);
const hubService = new HubService(repository, hubQueryEngine, { cachePath: path.join(args.runtimeDir, 'hub-cache.json') });
const hubServer = new HubServer(hubService, {
  tokenPath: path.join(args.runtimeDir, 'hub-token'),
  browserBroker,
});
const injectorScript = buildInjectorScript();
const targetInstallBackoff = new KeyedBackoff();

function readUsageCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return cached?.status === 'ok' && cached?.providerId ? cached : null;
  } catch {
    return null;
  }
}

function writeUsageCache(payload) {
  const temporary = `${cachePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
  fs.renameSync(temporary, cachePath);
}

let lastPayload = readUsageCache() || { status: 'loading', providerName: 'CCSwitch', message: '读取中…' };
const cachedQueryAt = Date.parse(String(lastPayload.updatedAt || ''));
let lastProviderId = lastPayload.providerId || '';
let lastQueryAt = Number.isFinite(cachedQueryAt) ? Math.min(Date.now(), cachedQueryAt) : 0;
let stopped = false;
let stopReason = null;
let lastStatusWriteAt = 0;
let lastConnectionError = null;
let lastHubError = null;
let mountedPages = 0;
let mountedTargetIds = new Set();
let lastInjectorAuditAt = 0;
let lastActionSignature = '';
let databaseWatcher = null;
let databaseWatchTimer = null;
let databaseChangeToken = repository.getChangeToken();
let lastDatabaseAuditAt = Date.now();
let controlWatcher = null;
let currentProviderRefreshTimer = null;
let currentProviderRefreshPromise = null;
let currentProviderRefreshPending = false;
let currentProviderRefreshForcePending = false;
let currentProviderRefreshInjectPending = false;
let targetSyncPromise = null;
let targetSyncPending = false;
let targetAuditPending = false;
let fallbackWake = null;

fs.writeFileSync(pidPath, String(process.pid), 'utf8');

function writeStatus(extra = {}) {
  const temporary = `${statusPath}.tmp`;
  const status = {
    running: true,
    pid: process.pid,
    port: args.port,
    provider: lastPayload.providerName || '',
    usageStatus: lastPayload.status || 'loading',
    eventDrivenTargets: false,
    databaseWatch: Boolean(databaseWatcher),
    controlWatch: Boolean(controlWatcher),
    fallbackPollMs: WATCHER_RETRY_MS,
    databaseAuditMs: DATABASE_AUDIT_MS,
    targetAuditMs: INJECTOR_AUDIT_MS,
    pageActionPollMs: PAGE_ACTION_POLL_MS,
    targetInstallFailures: targetInstallBackoff.failures,
    targetInstallRetryMs: targetInstallBackoff.remainingMs(),
    connectedPages: mountedPages,
    connectionError: lastConnectionError,
    hubRunning: Boolean(hubServer.boundPort),
    hubPort: hubServer.boundPort || null,
    hubProviders: hubService.getState().providers.length,
    browserCompanion: browserBroker.getStatus().connected,
    hubError: lastHubError,
    updatedAt: new Date().toISOString(),
    stopReason,
    ...extra,
  };
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2), 'utf8');
  fs.renameSync(temporary, statusPath);
  lastStatusWriteAt = Date.now();
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
}

function wakeFallbackPoll() {
  fallbackWake?.();
}

async function waitForFallbackPoll(delayMs) {
  await new Promise(resolve => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (fallbackWake === finish) fallbackWake = null;
      resolve();
    };
    fallbackWake = finish;
    timer = setTimeout(finish, Math.max(250, delayMs));
  });
}

function scheduleCurrentProviderRefresh(delayMs) {
  if (currentProviderRefreshTimer) clearTimeout(currentProviderRefreshTimer);
  if (stopped) return;
  currentProviderRefreshTimer = setTimeout(() => {
    currentProviderRefreshTimer = null;
    requestCurrentProviderRefresh(false, true);
  }, Math.max(1_000, delayMs));
}

async function refreshCurrentProvider(force = false) {
  let provider;
  try {
    provider = repository.getCurrent();
  } catch (error) {
    lastPayload = { status: 'error', providerName: 'CCSwitch', message: safeMessage(error) };
    writeStatus({ error: lastPayload.message });
    scheduleCurrentProviderRefresh(60_000);
    return true;
  }

  if (!provider) {
    lastPayload = { status: 'error', providerName: 'CCSwitch', message: '没有找到当前 Codex 供应商' };
    writeStatus({ error: lastPayload.message });
    scheduleCurrentProviderRefresh(60_000);
    return true;
  }

  const providerChanged = provider.id !== lastProviderId;
  const intervalMs = CURRENT_PROVIDER_REFRESH_MS;
  const elapsedMs = Date.now() - lastQueryAt;
  const due = elapsedMs >= intervalMs;
  if (!force && !providerChanged && !due) {
    scheduleCurrentProviderRefresh(intervalMs - elapsedMs);
    return false;
  }

  lastProviderId = provider.id;
  try {
    if (!hubService.findProvider(provider.id)) hubService.syncProviders();
    const item = await hubService.refreshProvider(provider.id);
    lastPayload = hubItemToUsagePayload(provider, item);
    if (lastPayload.status === 'ok') writeUsageCache(lastPayload);
    lastQueryAt = Date.now();
    const failed = ['error', 'login-required'].includes(item.status);
    writeStatus({ error: failed ? item.message : null });
    scheduleCurrentProviderRefresh(intervalMs);
    return true;
  } catch (error) {
    lastQueryAt = Date.now();
    const message = safeMessage(error);
    if (lastPayload.status === 'ok' && lastPayload.providerId === provider.id) {
      lastPayload = { ...lastPayload, queryError: message };
    } else {
      lastPayload = {
        status: 'error',
        providerId: provider.id,
        providerName: provider.name,
        websiteUrl: provider.websiteUrl,
        message,
        updatedAt: new Date().toISOString(),
      };
    }
    writeStatus({ error: message });
    scheduleCurrentProviderRefresh(intervalMs);
    return true;
  }
}

function requestCurrentProviderRefresh(force = false, inject = false) {
  currentProviderRefreshPending = true;
  currentProviderRefreshForcePending ||= force;
  currentProviderRefreshInjectPending ||= inject;
  if (currentProviderRefreshPromise) return currentProviderRefreshPromise;
  currentProviderRefreshPromise = (async () => {
    while (currentProviderRefreshPending && !stopped) {
      const currentForce = currentProviderRefreshForcePending;
      const currentInject = currentProviderRefreshInjectPending;
      currentProviderRefreshPending = false;
      currentProviderRefreshForcePending = false;
      currentProviderRefreshInjectPending = false;
      try {
        const changed = await refreshCurrentProvider(currentForce);
        if (currentInject && changed) await requestTargetSync({ audit: true });
      } catch (error) {
        writeStatus({ error: safeMessage(error) });
      }
    }
  })().finally(() => { currentProviderRefreshPromise = null; });
  return currentProviderRefreshPromise;
}

function openHubFromAction() {
  try {
    hubServer.open();
    lastHubError = null;
  } catch (error) {
    lastHubError = safeMessage(error);
    writeStatus({ hubError: lastHubError });
  }
}

function actionSignature(action) {
  return action ? `${action.action}:${action.token}:${action.requestedAt}` : '';
}

async function syncTargets({ audit = true } = {}) {
  let allTargets = await listCdpTargets(args.port);
  let targets = allTargets.filter(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl);
  if (targets.length === 0) {
    mountedPages = 0;
    mountedTargetIds = new Set();
    throw new Error('没有找到 Codex 主页面');
  }

  let targetActions = targets.map(target => ({ target, action: decodePageActionMarker(target.title) }));
  const markedActions = targetActions.filter(item => item.action);
  const pendingActions = markedActions.filter(item => actionSignature(item.action) !== lastActionSignature);
  const targetIds = new Set(targets.map(target => target.id));
  const targetSignature = [...targetIds].sort().join('|');
  const targetIdentityChanged = targetIds.size !== mountedTargetIds.size
    || [...targetIds].some(id => !mountedTargetIds.has(id));
  const shouldInstall = audit || targetIdentityChanged || markedActions.length > 0;

  if (!shouldInstall) {
    mountedPages = targets.length;
    return { installed: false, deferred: false };
  }
  if (pendingActions.length === 0 && !targetInstallBackoff.isReady(targetSignature)) {
    targetAuditPending = true;
    return { installed: false, deferred: true };
  }
  if (hasAuxiliaryPageTargets(allTargets)) {
    throw new Error('检测到 Codex 内置浏览器页面，已暂停 CDP 注入');
  }

  for (const item of pendingActions) {
    const signature = actionSignature(item.action);
    if (item.action.action === 'refresh') await refreshCurrentProvider(true);
    if (item.action.action === 'open-hub') openHubFromAction();
    lastActionSignature = signature;
  }

  if (pendingActions.length > 0) {
    allTargets = await listCdpTargets(args.port);
    if (hasAuxiliaryPageTargets(allTargets)) throw new Error('检测到 Codex 内置浏览器页面，已暂停 CDP 注入');
    targets = allTargets.filter(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl);
    if (targets.length === 0) {
      mountedPages = 0;
      mountedTargetIds = new Set();
      throw new Error('没有找到 Codex 主页面');
    }
    targetActions = targets.map(target => ({ target, action: decodePageActionMarker(target.title) }));
  }

  const results = await settleTargetOperations(targetActions, ({ target, action }) => installTargetOnce(target, {
    globalName: UPDATE_GLOBAL,
    injectorVersion: INJECTOR_VERSION,
    injectorScript,
    payload: lastPayload,
    acknowledgedTitle: action ? target.title : '',
  }));
  const failures = results.filter(result => result.status === 'rejected');
  mountedPages = results.length - failures.length;
  mountedTargetIds = new Set(
    targetActions
      .filter((_item, index) => results[index]?.status === 'fulfilled')
      .map(item => item.target.id),
  );
  lastInjectorAuditAt = Date.now();
  if (failures.length) {
    targetInstallBackoff.fail(targetSignature);
    targetAuditPending = true;
    throw failures[0].reason;
  }
  targetInstallBackoff.reset();
  return { installed: true, deferred: false };
}

function requestTargetSync({ audit = false } = {}) {
  targetSyncPending = true;
  targetAuditPending ||= audit;
  if (targetSyncPromise) return targetSyncPromise;
  targetSyncPromise = (async () => {
    const previousMountedPages = mountedPages;
    const previousConnectionError = lastConnectionError;
    const previousTargetInstallFailures = targetInstallBackoff.failures;
    while (targetSyncPending && !stopped) {
      const currentAudit = targetAuditPending;
      targetSyncPending = false;
      targetAuditPending = false;
      try {
        const outcome = await syncTargets({ audit: currentAudit });
        if (outcome?.deferred) targetAuditPending = true;
        else lastConnectionError = null;
      } catch (error) {
        lastConnectionError = safeMessage(error);
        targetAuditPending ||= currentAudit;
      }
    }
    if (
      mountedPages !== previousMountedPages
      || lastConnectionError !== previousConnectionError
      || targetInstallBackoff.failures !== previousTargetInstallFailures
    ) {
      writeStatus({ connectedPages: mountedPages, connectionError: lastConnectionError });
    }
  })().finally(() => { targetSyncPromise = null; });
  return targetSyncPromise;
}

function syncHubProviders() {
  try {
    return hubService.syncProviders().changed;
  } catch {
    return true;
  }
}

function startDatabaseWatcher() {
  if (databaseWatcher) return;
  try {
    const databaseDirectory = path.dirname(args.database);
    const databaseName = path.basename(args.database).toLowerCase();
    databaseWatcher = fs.watch(databaseDirectory, (_eventType, filename) => {
      const changedName = String(filename || '').toLowerCase();
      if (changedName && !changedName.startsWith(databaseName)) return;
      if (databaseWatchTimer) clearTimeout(databaseWatchTimer);
      databaseWatchTimer = setTimeout(() => {
        databaseWatchTimer = null;
        databaseChangeToken = repository.getChangeToken();
        lastDatabaseAuditAt = Date.now();
        const providersChanged = syncHubProviders();
        if (providersChanged) requestCurrentProviderRefresh(false, true);
      }, DATABASE_WATCH_DEBOUNCE_MS);
    });
    databaseWatcher.on('error', () => {
      databaseWatcher?.close();
      databaseWatcher = null;
      wakeFallbackPoll();
    });
  } catch {
    databaseWatcher = null;
  }
}

function startControlWatcher() {
  if (controlWatcher) return;
  const requestName = 'remount.request';
  const requestPath = path.join(args.runtimeDir, requestName);
  const consumeRequest = () => {
    try { fs.rmSync(requestPath, { force: true }); } catch {}
    requestTargetSync({ audit: true });
  };
  try {
    controlWatcher = fs.watch(args.runtimeDir, (_eventType, filename) => {
      if (String(filename || '').toLowerCase() === requestName) consumeRequest();
    });
    controlWatcher.on('error', () => {
      controlWatcher?.close();
      controlWatcher = null;
      wakeFallbackPoll();
    });
    if (fs.existsSync(requestPath)) consumeRequest();
  } catch {
    controlWatcher = null;
  }
}

function nextMaintenanceDelay() {
  const now = Date.now();
  const until = (lastAt, interval) => Math.max(250, interval - (now - lastAt));
  const injectorAuditDelay = targetAuditPending
    ? PAGE_ACTION_POLL_MS
    : until(lastInjectorAuditAt, INJECTOR_AUDIT_MS);
  return Math.min(
    databaseWatcher ? until(lastDatabaseAuditAt, DATABASE_AUDIT_MS) : WATCHER_RETRY_MS,
    controlWatcher ? injectorAuditDelay : WATCHER_RETRY_MS,
    PAGE_ACTION_POLL_MS,
    injectorAuditDelay,
    until(lastStatusWriteAt, STATUS_HEARTBEAT_MS),
  );
}

async function loop() {
  try {
    await hubServer.start();
    lastHubError = null;
  } catch (error) {
    lastHubError = safeMessage(error);
  }
  await requestTargetSync({ audit: true });
  startDatabaseWatcher();
  startControlWatcher();
  writeStatus({ connectedPages: mountedPages, connectionError: lastConnectionError });
  requestCurrentProviderRefresh(false, true);
  while (!stopped) {
    await waitForFallbackPoll(nextMaintenanceDelay());
    if (stopped) break;
    const now = Date.now();
    const databaseAuditDue = !databaseWatcher || now - lastDatabaseAuditAt >= DATABASE_AUDIT_MS;
    let databaseChanged = false;
    if (databaseAuditDue) {
      const currentDatabaseChangeToken = repository.getChangeToken();
      databaseChanged = currentDatabaseChangeToken !== databaseChangeToken;
      databaseChangeToken = currentDatabaseChangeToken;
      lastDatabaseAuditAt = now;
    }
    const providersChanged = databaseChanged && syncHubProviders();
    startDatabaseWatcher();
    startControlWatcher();
    const auditDue = now - lastInjectorAuditAt >= INJECTOR_AUDIT_MS;
    await Promise.allSettled([
      providersChanged ? requestCurrentProviderRefresh(false, true) : Promise.resolve(),
      requestTargetSync({ audit: auditDue || providersChanged }),
    ]);
    if (Date.now() - lastStatusWriteAt >= STATUS_HEARTBEAT_MS) {
      writeStatus({ connectedPages: mountedPages, connectionError: lastConnectionError });
    }
  }
}

function shutdown(reason = null) {
  if (stopped) return;
  stopReason = reason;
  stopped = true;
  wakeFallbackPoll();
  databaseWatcher?.close();
  controlWatcher?.close();
  const auxiliaryShutdown = Promise.allSettled([hubServer.close()]);
  browserBroker.close();
  if (databaseWatchTimer) clearTimeout(databaseWatchTimer);
  if (currentProviderRefreshTimer) clearTimeout(currentProviderRefreshTimer);
  repository.close();
  try { fs.rmSync(pidPath, { force: true }); } catch {}
  try { writeStatus({ running: false, connectedPages: 0 }); } catch {}
  Promise.race([
    auxiliaryShutdown,
    new Promise(resolve => setTimeout(resolve, 750)),
  ]).finally(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', error => {
  shutdown(`uncaughtException: ${safeMessage(error)}`);
});
process.on('unhandledRejection', error => {
  shutdown(`unhandledRejection: ${safeMessage(error)}`);
});

writeStatus({ connectedPages: 0 });
await loop();
