import fs from 'node:fs';
import path from 'node:path';
import { ProviderRepository } from './provider-repository.mjs';
import { queryUsage } from './usage-client.mjs';
import { CdpClient, getBrowserWebSocketUrl, isCodexAuxiliaryTarget, isCodexTargetCandidate, listCodexTargets } from './cdp-client.mjs';
import { CdpDisconnectGuard } from './cdp-disconnect-guard.mjs';
import { EdgeSession } from './edge-session.mjs';
import { HubServer } from './hub-server.mjs';
import { ProviderQueryEngine } from './hub-provider-adapters.mjs';
import { HubService } from './hub-service.mjs';
import { buildInjectorScript, HUB_BINDING, INJECTOR_VERSION, REFRESH_BINDING, UPDATE_GLOBAL } from './injector-script.mjs';
import { TargetDiscovery } from './target-discovery.mjs';
import { disposeTargetInjector, settleTargetOperations, TargetSession } from './target-session.mjs';

const DATABASE_WATCH_DEBOUNCE_MS = 100;
const CDP_DISCONNECT_GRACE_MS = 3_000;
const DEGRADED_FALLBACK_POLL_MS = 30_000;
const HEALTHY_FALLBACK_POLL_MS = 300_000;
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
const edgeSession = new EdgeSession(path.join(args.runtimeDir, 'hub-edge-profile'));
const hubQueryEngine = new ProviderQueryEngine(repository, edgeSession);
const hubService = new HubService(repository, hubQueryEngine, { cachePath: path.join(args.runtimeDir, 'hub-cache.json') });
const hubServer = new HubServer(hubService, { tokenPath: path.join(args.runtimeDir, 'hub-token') });
const sessions = new Map();
const cleanedAuxiliaryTargetIds = new Set();
const injectorScript = buildInjectorScript();
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
let lastProviderId = lastPayload.providerId || '';
let lastQueryAt = 0;
let stopped = false;
let stopReason = null;
let lastStatusWriteAt = 0;
let lastConnectionError = null;
let lastHubError = null;
let targetDiscovery = null;
let databaseWatcher = null;
let databaseWatchTimer = null;
let databaseChangeToken = repository.getChangeToken();
let controlWatcher = null;
let usageRefreshTimer = null;
let targetSyncPromise = null;
let targetSyncPending = false;
let refreshPromise = null;
let refreshPending = false;
let refreshForcePending = false;
let refreshBroadcastPending = false;
let fallbackWake = null;
const cdpDisconnectGuard = new CdpDisconnectGuard({
  graceMs: CDP_DISCONNECT_GRACE_MS,
  verifyConnection: verifyCdpConnection,
  onExpired: () => shutdown('CDP disconnected'),
});

fs.writeFileSync(pidPath, String(process.pid), 'utf8');

function writeStatus(extra = {}) {
  const temporary = `${statusPath}.tmp`;
  const status = {
    running: true,
    pid: process.pid,
    port: args.port,
    provider: lastPayload.providerName || '',
    usageStatus: lastPayload.status || 'loading',
    eventDrivenTargets: Boolean(targetDiscovery && !targetDiscovery.client.closed),
    databaseWatch: Boolean(databaseWatcher),
    controlWatch: Boolean(controlWatcher),
    fallbackPollMs: getFallbackPollMs(),
    connectedPages: sessions.size,
    connectionError: lastConnectionError,
    hubRunning: Boolean(hubServer.boundPort),
    hubPort: hubServer.boundPort || null,
    hubProviders: hubService.getState().providers.length,
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

function getFallbackPollMs() {
  const targetEventsHealthy = Boolean(targetDiscovery && !targetDiscovery.client.closed);
  return targetEventsHealthy && databaseWatcher && controlWatcher
    ? HEALTHY_FALLBACK_POLL_MS
    : DEGRADED_FALLBACK_POLL_MS;
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
    timer = setTimeout(finish, Math.max(1_000, delayMs));
  });
}

function scheduleUsageRefresh(delayMs) {
  if (usageRefreshTimer) clearTimeout(usageRefreshTimer);
  if (stopped) return;
  usageRefreshTimer = setTimeout(() => {
    usageRefreshTimer = null;
    requestUsageRefresh(false, true);
  }, Math.max(1_000, delayMs));
}

async function refreshUsage(force = false) {
  let provider;
  try {
    provider = repository.getCurrent();
  } catch (error) {
    lastPayload = { status: 'error', providerName: 'CCSwitch', message: safeMessage(error) };
    writeStatus({ error: lastPayload.message });
    scheduleUsageRefresh(30_000);
    return;
  }

  if (!provider) {
    lastPayload = { status: 'error', providerName: 'CCSwitch', message: '没有找到当前 Codex 供应商' };
    writeStatus({ error: lastPayload.message });
    scheduleUsageRefresh(30_000);
    return;
  }

  const providerChanged = provider.id !== lastProviderId;
  const intervalMinutes = Math.max(1, Number(provider.usage?.autoQueryInterval || 5));
  const intervalMs = intervalMinutes * 60_000;
  const elapsedMs = Date.now() - lastQueryAt;
  const due = elapsedMs >= intervalMs;
  if (!force && !providerChanged && !due) {
    scheduleUsageRefresh(intervalMs - elapsedMs);
    return;
  }

  lastProviderId = provider.id;
  if (!provider.usage?.enabled || !String(provider.usage.code || '').trim()) {
    lastQueryAt = Date.now();
    lastPayload = { status: 'unsupported', providerId: provider.id, providerName: provider.name, websiteUrl: provider.websiteUrl, message: '未配置用量' };
    hubService.recordCurrent(provider, lastPayload);
    writeStatus();
    scheduleUsageRefresh(intervalMs);
    return;
  }

  try {
    lastPayload = await queryUsage(provider);
    hubService.recordCurrent(provider, lastPayload);
    writeUsageCache(lastPayload);
    lastQueryAt = Date.now();
    writeStatus({ error: null });
    scheduleUsageRefresh(intervalMs);
  } catch (error) {
    // Retry transient quota endpoint failures after 30 seconds rather than
    // waiting for the provider's full auto-query interval.
    lastQueryAt = Date.now() - intervalMinutes * 60_000 + 30_000;
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
    hubService.recordCurrent(provider, lastPayload);
    writeStatus({ error: message });
    scheduleUsageRefresh(30_000);
  }
}

async function syncTargets() {
  const discoveredTargets = await listCodexTargets(args.port, { includeAuxiliary: true });
  const targets = discoveredTargets.filter(isCodexTargetCandidate);
  const auxiliaryTargets = discoveredTargets.filter(isCodexAuxiliaryTarget);
  const activeIds = new Set(targets.map(target => target.id));
  const auxiliaryIds = new Set(auxiliaryTargets.map(target => target.id));
  for (const id of cleanedAuxiliaryTargetIds) {
    if (!auxiliaryIds.has(id)) cleanedAuxiliaryTargetIds.delete(id);
  }
  for (const [id, session] of sessions) {
    if (!activeIds.has(id) || session.closed) {
      session.close();
      sessions.delete(id);
    }
  }

  async function syncTarget(target) {
    let session = sessions.get(target.id);
    try {
      if (!session || session.closed) {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl);
        session = new TargetSession(client, {
          globalName: UPDATE_GLOBAL,
          injectorVersion: INJECTOR_VERSION,
          injectorScript,
          refreshBindingName: REFRESH_BINDING,
          onRefresh: () => requestUsageRefresh(true, true),
          actionBindingName: HUB_BINDING,
          onAction: payload => {
            if (payload?.action !== 'open-hub') return;
            try {
              hubServer.open();
              lastHubError = null;
            } catch (error) {
              lastHubError = safeMessage(error);
              writeStatus({ hubError: lastHubError });
            }
          },
          onContextReset: () => requestTargetSync(),
        });
        sessions.set(target.id, session);
        await session.initialize();
      }
      await session.ensureInjector();
      await session.updatePayload(lastPayload);
      return true;
    } catch (error) {
      session?.close();
      sessions.delete(target.id);
      throw error;
    }
  }

  async function cleanupAuxiliaryTarget(target) {
    if (cleanedAuxiliaryTargetIds.has(target.id)) return false;
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      await disposeTargetInjector(client, UPDATE_GLOBAL);
      cleanedAuxiliaryTargetIds.add(target.id);
      return true;
    } finally {
      client.close();
    }
  }

  await Promise.all([
    settleTargetOperations(targets, syncTarget),
    settleTargetOperations(auxiliaryTargets, cleanupAuxiliaryTarget),
  ]);
}

async function broadcastPayload() {
  await settleTargetOperations([...sessions], async ([id, session]) => {
    try {
      await session.updatePayload(lastPayload);
    } catch (error) {
      session.close();
      sessions.delete(id);
      throw error;
    }
  });
}

function requestUsageRefresh(force = false, broadcast = false) {
  refreshPending = true;
  refreshForcePending ||= force;
  refreshBroadcastPending ||= broadcast;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    while (refreshPending && !stopped) {
      const currentForce = refreshForcePending;
      const currentBroadcast = refreshBroadcastPending;
      refreshPending = false;
      refreshForcePending = false;
      refreshBroadcastPending = false;
      try {
        await refreshUsage(currentForce);
        if (currentBroadcast) await broadcastPayload();
      } catch (error) {
        const message = safeMessage(error);
        writeStatus({ error: message });
      }
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function requestTargetSync() {
  targetSyncPending = true;
  if (targetSyncPromise) return targetSyncPromise;
  targetSyncPromise = (async () => {
    while (targetSyncPending && !stopped) {
      targetSyncPending = false;
      try {
        await syncTargets();
        if (lastConnectionError) {
          lastConnectionError = null;
          writeStatus({ connectedPages: sessions.size, connectionError: null });
        }
      } catch (error) {
        lastConnectionError = safeMessage(error);
        writeStatus({ connectedPages: sessions.size, connectionError: lastConnectionError });
      }
    }
  })().finally(() => { targetSyncPromise = null; });
  return targetSyncPromise;
}

async function startTargetDiscovery() {
  if (targetDiscovery && !targetDiscovery.client.closed) {
    cdpDisconnectGuard.notifyConnected();
    return true;
  }
  targetDiscovery?.close();
  targetDiscovery = null;
  try {
    const browserUrl = await getBrowserWebSocketUrl(args.port);
    const client = await CdpClient.connect(browserUrl);
    const discovery = new TargetDiscovery(client, requestTargetSync, {
      onDisconnect: () => cdpDisconnectGuard.notifyDisconnected(),
    });
    await discovery.start();
    targetDiscovery = discovery;
    cdpDisconnectGuard.notifyConnected();
    return true;
  } catch (error) {
    lastConnectionError = `Target 事件不可用，使用兜底轮询: ${safeMessage(error)}`;
    return false;
  }
}

async function verifyCdpConnection() {
  if (!await startTargetDiscovery()) return false;
  await requestTargetSync();
  return true;
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
        try { hubService.syncProviders(); } catch {}
        requestUsageRefresh(false, true);
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
    requestTargetSync();
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

async function loop() {
  try {
    await hubServer.start();
    lastHubError = null;
  } catch (error) {
    lastHubError = safeMessage(error);
  }
  await requestTargetSync();
  await startTargetDiscovery();
  startDatabaseWatcher();
  startControlWatcher();
  writeStatus({ connectedPages: sessions.size, connectionError: lastConnectionError });
  requestUsageRefresh(false, true);
  while (!stopped) {
    await waitForFallbackPoll(getFallbackPollMs());
    if (stopped) break;
    const currentDatabaseChangeToken = repository.getChangeToken();
    const databaseChanged = currentDatabaseChangeToken !== databaseChangeToken;
    databaseChangeToken = currentDatabaseChangeToken;
    startDatabaseWatcher();
    startControlWatcher();
    await Promise.allSettled([
      databaseChanged ? requestUsageRefresh(false, true) : Promise.resolve(),
      requestTargetSync(),
      startTargetDiscovery(),
    ]);
    if (Date.now() - lastStatusWriteAt >= STATUS_HEARTBEAT_MS) {
      writeStatus({ connectedPages: sessions.size, connectionError: lastConnectionError });
    }
  }
}

function shutdown(reason = null) {
  if (stopped) return;
  stopReason = reason;
  stopped = true;
  wakeFallbackPoll();
  cdpDisconnectGuard.close();
  targetDiscovery?.close();
  databaseWatcher?.close();
  controlWatcher?.close();
  const auxiliaryShutdown = Promise.allSettled([
    hubServer.close(),
    edgeSession.closeIfHeadless(),
  ]);
  if (databaseWatchTimer) clearTimeout(databaseWatchTimer);
  if (usageRefreshTimer) clearTimeout(usageRefreshTimer);
  for (const session of sessions.values()) session.close();
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
