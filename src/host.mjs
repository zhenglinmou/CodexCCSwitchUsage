import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserCallbackBroker } from './browser-callback-broker.mjs';
import { hasAuxiliaryPageTargets, isCodexTargetCandidate, listCdpTargets } from './cdp-client.mjs';
import { ProviderRepository } from './provider-repository.mjs';
import { HubServer } from './hub-server.mjs';
import { ProviderQueryEngine } from './hub-provider-adapters.mjs';
import { hubItemToUsagePayload, HubService } from './hub-service.mjs';
import { buildInjectorScript, INJECTOR_VERSION, UPDATE_GLOBAL } from './injector-script.mjs';
import { KeyedBackoff } from './keyed-backoff.mjs';
import { decodePageActionMarker } from './page-action-channel.mjs';
import { isProcessAlive, ProcessExitMonitor } from './process-lifecycle.mjs';
import { acknowledgePageAction, installTargetOnce, settleTargetOperations } from './target-session.mjs';

const DATABASE_WATCH_DEBOUNCE_MS = 100;
const CURRENT_PROVIDER_REFRESH_MS = 300_000;
const WATCHER_RETRY_MS = 1_000;
const PAGE_ACTION_POLL_MS = 1_000;
const DATABASE_AUDIT_MS = 60_000;
const INJECTOR_AUDIT_MS = 300_000;
const STATUS_HEARTBEAT_MS = 300_000;
const HUB_RETRY_MS = 5_000;
const RECENT_REQUEST_LIMIT = 10;
const CODEX_PROCESS_POLL_MS = 250;

function parseArgs(argv) {
  const result = { port: 9334, database: path.join(process.env.USERPROFILE, '.cc-switch', 'cc-switch.db'), runtimeDir: path.join(process.cwd(), 'runtime'), codexPid: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--port') result.port = Number(value);
    if (argv[index] === '--database') result.database = value;
    if (argv[index] === '--runtime-dir') result.runtimeDir = value;
    if (argv[index] === '--codex-pid') result.codexPid = Number(value);
  }
  if (!Number.isInteger(result.codexPid) || result.codexPid <= 0) throw new Error('A live Codex root PID is required.');
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!isProcessAlive(args.codexPid)) throw new Error(`Codex root process ${args.codexPid} is not running.`);
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

function writeUsageCache(payload, providerSignature = '') {
  const temporary = `${cachePath}.tmp`;
  const cachePayload = { ...payload };
  delete cachePayload.recentRequests;
  fs.writeFileSync(temporary, JSON.stringify({ ...cachePayload, providerSignature }), 'utf8');
  fs.renameSync(temporary, cachePath);
}

const cachedUsage = readUsageCache();
const cachedProviderSignature = String(cachedUsage?.providerSignature || '');
if (cachedUsage) delete cachedUsage.providerSignature;
let lastPayload = cachedUsage || { status: 'loading', providerName: 'CCSwitch', message: '读取中…' };
const cachedQueryAt = Date.parse(String(lastPayload.updatedAt || ''));
let lastProviderId = lastPayload.providerId || '';
let lastProviderSignature = cachedProviderSignature;
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
let currentProviderQueryActive = false;
let targetSyncPromise = null;
let targetSyncPending = false;
let targetAuditPending = false;
let fallbackWake = null;
let lastHubStartAttemptAt = 0;
let recentRequestProviderId = '';
let recentRequests = [];
let recentRequestsSignature = '';
let codexProcessMonitor = null;

fs.writeFileSync(pidPath, String(process.pid), 'utf8');

function writeStatus(extra = {}) {
  const temporary = `${statusPath}.tmp`;
  const status = {
    running: true,
    pid: process.pid,
    codexProcessId: args.codexPid,
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

function providerRefreshSignature(provider) {
  if (!provider) return '';
  const material = JSON.stringify([
    provider.id,
    provider.name,
    provider.websiteUrl,
    provider.apiKey,
    provider.apiBaseUrl,
    provider.baseUrl,
    provider.auth,
    provider.usage,
  ]);
  return crypto.createHash('sha256').update(material).digest('base64url');
}

function payloadWithRecentRequests(payload) {
  const providerId = String(payload?.providerId || '');
  return {
    ...payload,
    recentRequests: providerId && providerId === recentRequestProviderId ? recentRequests : [],
  };
}

function syncRecentRequests(providerOverride = undefined) {
  try {
    const provider = providerOverride === undefined ? repository.getCurrent() : providerOverride;
    const providerId = String(provider?.id || '');
    const nextRequests = providerId ? repository.getRecentRequests(providerId, RECENT_REQUEST_LIMIT) : [];
    const nextSignature = JSON.stringify([providerId, nextRequests]);
    if (nextSignature === recentRequestsSignature) return false;
    recentRequestProviderId = providerId;
    recentRequests = nextRequests;
    recentRequestsSignature = nextSignature;

    if (providerId && String(lastPayload?.providerId || '') === providerId) {
      lastPayload = payloadWithRecentRequests(lastPayload);
      return true;
    }
    if (providerId && !lastPayload?.providerId && lastPayload?.status === 'loading') {
      lastPayload = payloadWithRecentRequests({
        ...lastPayload,
        providerId,
        providerName: provider.name,
        websiteUrl: provider.websiteUrl,
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
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
    syncRecentRequests(null);
    lastProviderId = '';
    lastProviderSignature = '';
    lastPayload = payloadWithRecentRequests({ status: 'error', providerName: 'CCSwitch', message: '没有找到当前 Codex 供应商' });
    writeStatus({ error: lastPayload.message });
    scheduleCurrentProviderRefresh(60_000);
    return true;
  }

  syncRecentRequests(provider);

  const providerChanged = provider.id !== lastProviderId;
  const providerSignature = providerRefreshSignature(provider);
  const providerConfigurationChanged = providerSignature !== lastProviderSignature;
  const intervalMs = CURRENT_PROVIDER_REFRESH_MS;
  const elapsedMs = Date.now() - lastQueryAt;
  const due = elapsedMs >= intervalMs;
  if (!force && !providerChanged && !providerConfigurationChanged && !due) {
    scheduleCurrentProviderRefresh(intervalMs - elapsedMs);
    return false;
  }

  let configurationReady = false;
  try {
    const syncResult = syncHubProviders();
    if (!syncResult.succeeded) throw syncResult.error;
    const hubProvider = hubService.findProvider(provider.id);
    if (!hubProvider) throw new Error('当前供应商尚未同步到 Balance Hub');
    if (providerRefreshSignature(hubProvider) !== providerSignature) {
      throw new Error('当前供应商配置与 Balance Hub 快照不一致');
    }
    configurationReady = true;
    lastProviderId = provider.id;
    lastProviderSignature = providerSignature;
    const item = await hubService.refreshProvider(provider.id);
    if (!item) throw new Error('当前供应商在额度刷新期间已变更');
    lastPayload = payloadWithRecentRequests(hubItemToUsagePayload(provider, item));
    if (lastPayload.status === 'ok') writeUsageCache(lastPayload, providerSignature);
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
      lastPayload = payloadWithRecentRequests({
        status: 'error',
        providerId: provider.id,
        providerName: provider.name,
        websiteUrl: provider.websiteUrl,
        message,
        updatedAt: new Date().toISOString(),
      });
    }
    writeStatus({ error: message });
    scheduleCurrentProviderRefresh(configurationReady ? intervalMs : 60_000);
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
        currentProviderQueryActive = true;
        const changed = await refreshCurrentProvider(currentForce).finally(() => {
          currentProviderQueryActive = false;
        });
        if (currentInject && changed) {
          if (currentProviderRefreshPending) currentProviderRefreshInjectPending = true;
          else await requestTargetSync({ audit: true });
        }
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

async function ensureHubServer(force = false) {
  if (hubServer.boundPort) return true;
  const now = Date.now();
  if (!force && now - lastHubStartAttemptAt < HUB_RETRY_MS) return false;
  lastHubStartAttemptAt = now;
  const previousError = lastHubError;
  try {
    await hubServer.start();
    lastHubError = null;
    if (previousError) writeStatus({ hubError: null });
    return true;
  } catch (error) {
    lastHubError = safeMessage(error);
    if (lastHubError !== previousError) writeStatus({ hubError: lastHubError });
    return false;
  }
}

function actionSignature(action) {
  return action ? `${action.action}:${action.token}:${action.requestedAt}` : '';
}

async function syncTargets({ audit = true } = {}) {
  const allTargets = await listCdpTargets(args.port);
  const targets = allTargets.filter(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl);
  if (targets.length === 0) {
    mountedPages = 0;
    mountedTargetIds = new Set();
    throw new Error('没有找到 Codex 主页面');
  }

  const targetActions = targets.map(target => ({ target, action: decodePageActionMarker(target.title) }));
  const markedActions = targetActions.filter(item => item.action);
  const targetIds = new Set(targets.map(target => target.id));
  const targetSignature = [...targetIds].sort().join('|');
  const targetIdentityChanged = targetIds.size !== mountedTargetIds.size
    || [...targetIds].some(id => !mountedTargetIds.has(id));
  const shouldInstall = audit || targetIdentityChanged || markedActions.length > 0;

  if (!shouldInstall) {
    mountedPages = targets.length;
    return { installed: false, deferred: false };
  }
  if (markedActions.length === 0 && !targetInstallBackoff.isReady(targetSignature)) {
    targetAuditPending = true;
    return { installed: false, deferred: true };
  }
  if (hasAuxiliaryPageTargets(allTargets)) {
    throw new Error('检测到 Codex 内置浏览器页面，已暂停 CDP 注入');
  }

  if (markedActions.length > 0) {
    const acknowledgements = await settleTargetOperations(
      markedActions,
      ({ target }) => acknowledgePageAction(target, target.title),
    );
    const failures = acknowledgements.filter(result => result.status === 'rejected');
    let refreshRequested = false;
    let actionAccepted = false;
    markedActions.forEach((item, index) => {
      if (acknowledgements[index]?.status !== 'fulfilled' || acknowledgements[index].value !== true) return;
      if (actionSignature(item.action) === lastActionSignature) return;
      actionAccepted = true;
      lastActionSignature = actionSignature(item.action);
      if (item.action.action === 'refresh') {
        refreshRequested = true;
        requestCurrentProviderRefresh(true, true);
      }
      if (item.action.action === 'open-hub') openHubFromAction();
    });
    mountedPages = targets.length;
    if (actionAccepted) targetInstallBackoff.reset();
    if (failures.length) throw failures[0].reason;
    return {
      installed: false,
      deferred: !refreshRequested && actionAccepted && (audit || targetIdentityChanged),
    };
  }

  if (currentProviderQueryActive) return { installed: false, deferred: audit || targetIdentityChanged };

  const installTargets = targets.map(target => ({ target }));
  const results = await settleTargetOperations(installTargets, ({ target }) => installTargetOnce(target, {
    globalName: UPDATE_GLOBAL,
    injectorVersion: INJECTOR_VERSION,
    injectorScript,
    payload: lastPayload,
  }));
  const failures = results.filter(result => result.status === 'rejected');
  mountedPages = results.length - failures.length;
  mountedTargetIds = new Set(
    installTargets
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
    return { succeeded: true, changed: hubService.syncProviders().changed, error: null };
  } catch (error) {
    return { succeeded: false, changed: false, error };
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
        const nextDatabaseChangeToken = repository.getChangeToken();
        const syncResult = syncHubProviders();
        if (!syncResult.succeeded) {
          lastDatabaseAuditAt = Date.now() - DATABASE_AUDIT_MS + WATCHER_RETRY_MS;
          writeStatus({ error: safeMessage(syncResult.error) });
          wakeFallbackPoll();
          return;
        }
        databaseChangeToken = nextDatabaseChangeToken;
        lastDatabaseAuditAt = Date.now();
        const recentRequestsChanged = syncRecentRequests();
        if (syncResult.changed) requestCurrentProviderRefresh(false, true);
        else if (recentRequestsChanged) requestTargetSync({ audit: true });
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
  await ensureHubServer(true);
  syncRecentRequests();
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
    let providersChanged = false;
    let recentRequestsChanged = false;
    if (databaseAuditDue) {
      const currentDatabaseChangeToken = repository.getChangeToken();
      if (currentDatabaseChangeToken !== databaseChangeToken) {
        const syncResult = syncHubProviders();
        if (syncResult.succeeded) {
          databaseChangeToken = currentDatabaseChangeToken;
          lastDatabaseAuditAt = now;
          providersChanged = syncResult.changed;
          recentRequestsChanged = syncRecentRequests();
        } else {
          lastDatabaseAuditAt = now - DATABASE_AUDIT_MS + WATCHER_RETRY_MS;
          writeStatus({ error: safeMessage(syncResult.error) });
        }
      } else {
        lastDatabaseAuditAt = now;
      }
    }
    startDatabaseWatcher();
    startControlWatcher();
    const auditDue = now - lastInjectorAuditAt >= INJECTOR_AUDIT_MS;
    await Promise.allSettled([
      ensureHubServer(),
      providersChanged ? requestCurrentProviderRefresh(false, true) : Promise.resolve(),
      requestTargetSync({ audit: auditDue || providersChanged || recentRequestsChanged }),
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
  const forceExitTimer = setTimeout(() => process.exit(0), 750);
  wakeFallbackPoll();
  codexProcessMonitor?.close();
  databaseWatcher?.close();
  controlWatcher?.close();
  const auxiliaryShutdown = Promise.allSettled([hubServer.close()]);
  browserBroker.close();
  if (databaseWatchTimer) clearTimeout(databaseWatchTimer);
  if (currentProviderRefreshTimer) clearTimeout(currentProviderRefreshTimer);
  repository.close();
  try { fs.rmSync(pidPath, { force: true }); } catch {}
  try { writeStatus({ running: false, connectedPages: 0 }); } catch {}
  auxiliaryShutdown.finally(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', error => {
  shutdown(`uncaughtException: ${safeMessage(error)}`);
});
process.on('unhandledRejection', error => {
  shutdown(`unhandledRejection: ${safeMessage(error)}`);
});

codexProcessMonitor = new ProcessExitMonitor({
  processId: args.codexPid,
  intervalMs: CODEX_PROCESS_POLL_MS,
  onExit: () => shutdown('Codex root process exited'),
});
codexProcessMonitor.start();
if (!stopped) {
  writeStatus({ connectedPages: 0 });
  await loop();
}
