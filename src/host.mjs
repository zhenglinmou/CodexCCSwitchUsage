import fs from 'node:fs';
import path from 'node:path';
import { BrowserCallbackBroker } from './browser-callback-broker.mjs';
import { isCodexTargetCandidate, listCdpTargets } from './cdp-client.mjs';
import { ProviderRepository } from './provider-repository.mjs';
import { ProviderRequestUsageEngine } from './provider-request-usage.mjs';
import { HubServer } from './hub-server.mjs';
import { ProviderQueryEngine } from './hub-provider-adapters.mjs';
import { hubItemToUsagePayload, HubService, providerConfigurationFingerprint, safeHubMessage } from './hub-service.mjs';
import { buildInjectorScript, INJECTOR_VERSION, UPDATE_GLOBAL } from './injector-script.mjs';
import { KeyedBackoff } from './keyed-backoff.mjs';
import { decodePageActionQueue } from './page-action-channel.mjs';
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
const providerRequestUsageEngine = new ProviderRequestUsageEngine({ browserBroker });
const hubService = new HubService(repository, hubQueryEngine, {
  cachePath: path.join(args.runtimeDir, 'hub-cache.json'),
  requestUsageEngine: providerRequestUsageEngine,
});
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
  delete cachePayload.recentRequestsLoading;
  delete cachePayload.recentRequestsSource;
  delete cachePayload.recentRequestsPreciseCost;
  delete cachePayload.recentRequestsFetchedAt;
  delete cachePayload.recentRequestsMessage;
  fs.writeFileSync(temporary, JSON.stringify({ ...cachePayload, providerSignature }), 'utf8');
  fs.renameSync(temporary, cachePath);
}

let cachedUsage = readUsageCache();
let cachedProviderSignature = String(cachedUsage?.providerSignature || '');
if (cachedUsage) {
  try {
    const currentProvider = repository.getCurrent();
    const cacheMatchesCurrent = Boolean(
      currentProvider
      && cachedUsage.providerId === currentProvider.id
      && cachedProviderSignature
      && cachedProviderSignature === providerConfigurationFingerprint(currentProvider)
    );
    if (!cacheMatchesCurrent) {
      cachedUsage = null;
      cachedProviderSignature = '';
    }
  } catch {
    cachedUsage = null;
    cachedProviderSignature = '';
  }
}
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
const recentActionSignatures = new Set();
const recentActionSignatureOrder = [];
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
let recentRequestsLoading = false;
let recentRequestsSource = 'ccswitch_local';
let recentRequestsPreciseCost = false;
let recentRequestsFetchedAt = '';
let recentRequestsMessage = '';
let recentRequestsRefreshPromise = null;
let recentRequestsRefreshPending = false;
let codexProcessMonitor = null;

fs.writeFileSync(pidPath, String(process.pid), 'utf8');

function writeStatus(extra = {}) {
  const temporary = `${statusPath}.tmp`;
  const stopping = stopped || extra.running === false;
  const status = {
    running: !stopping,
    pid: stopping ? null : process.pid,
    codexProcessId: args.codexPid,
    port: args.port,
    provider: lastPayload.providerName || '',
    usageStatus: lastPayload.status || 'loading',
    eventDrivenTargets: false,
    databaseWatch: stopping ? false : Boolean(databaseWatcher),
    controlWatch: stopping ? false : Boolean(controlWatcher),
    fallbackPollMs: WATCHER_RETRY_MS,
    databaseAuditMs: DATABASE_AUDIT_MS,
    targetAuditMs: INJECTOR_AUDIT_MS,
    pageActionPollMs: PAGE_ACTION_POLL_MS,
    targetInstallFailures: targetInstallBackoff.failures,
    targetInstallRetryMs: targetInstallBackoff.remainingMs(),
    connectedPages: mountedPages,
    connectionError: lastConnectionError,
    hubRunning: stopping ? false : Boolean(hubServer.boundPort),
    hubPort: stopping ? null : (hubServer.boundPort || null),
    hubProviders: hubService.getState().providers.length,
    browserCompanion: stopping ? false : browserBroker.getStatus().connected,
    hubError: lastHubError,
    updatedAt: new Date().toISOString(),
    stopReason,
    ...extra,
    ...(stopping ? {
      running: false,
      pid: null,
      databaseWatch: false,
      controlWatch: false,
      connectedPages: 0,
      hubRunning: false,
      hubPort: null,
      browserCompanion: false,
    } : {}),
  };
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2), 'utf8');
  fs.renameSync(temporary, statusPath);
  lastStatusWriteAt = Date.now();
}

function safeMessage(error) {
  return safeHubMessage(error);
}

function providerRefreshSignature(provider) {
  return providerConfigurationFingerprint(provider);
}

function payloadWithRecentRequests(payload) {
  const providerId = String(payload?.providerId || '');
  const matches = Boolean(providerId && providerId === recentRequestProviderId);
  return {
    ...payload,
    recentRequests: matches ? recentRequests : [],
    recentRequestsLoading: matches ? recentRequestsLoading : false,
    recentRequestsSource: matches ? recentRequestsSource : '',
    recentRequestsPreciseCost: matches ? recentRequestsPreciseCost : false,
    recentRequestsFetchedAt: matches ? recentRequestsFetchedAt : '',
    recentRequestsMessage: matches ? recentRequestsMessage : '',
  };
}

function normalizedRecentRequest(item, defaults = {}) {
  const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const optionalInteger = value => {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const text = (value, maximum = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
  const rawTotalCost = item?.totalCost ?? item?.totalCostUsd;
  const totalCost = rawTotalCost == null || rawTotalCost === '' ? null : number(rawTotalCost, null);
  const costUnit = text(item?.costUnit || defaults.costUnit || 'USD', 24) || 'USD';
  const statusCode = optionalInteger(item?.statusCode);
  const success = typeof item?.success === 'boolean'
    ? item.success
    : statusCode == null || (statusCode >= 200 && statusCode < 400);
  return {
    createdAt: text(item?.createdAt, 40),
    model: text(item?.model),
    requestModel: text(item?.requestModel),
    inputTokens: Math.trunc(number(item?.inputTokens, 0)),
    outputTokens: Math.trunc(number(item?.outputTokens, 0)),
    cacheReadTokens: Math.trunc(number(item?.cacheReadTokens, 0)),
    cacheCreationTokens: Math.trunc(number(item?.cacheCreationTokens, 0)),
    totalCost,
    totalCostUsd: costUnit.toUpperCase() === 'USD' ? totalCost : null,
    costUnit,
    costExact: item?.costExact === true || defaults.costExact === true,
    costSource: text(item?.costSource || defaults.costSource, 40),
    latencyMs: optionalInteger(item?.latencyMs),
    firstTokenMs: optionalInteger(item?.firstTokenMs),
    statusCode,
    success,
  };
}

function updateRecentRequestsState(provider, items, options = {}) {
  const providerId = String(provider?.id || '');
  const nextRequests = providerId
    ? (Array.isArray(items) ? items : []).slice(0, RECENT_REQUEST_LIMIT).map(item => normalizedRecentRequest(item, options))
    : [];
  const nextState = {
    providerId,
    requests: nextRequests,
    loading: options.loading === true,
    source: String(options.source || (providerId ? 'ccswitch_local' : '')),
    preciseCost: options.preciseCost === true,
    fetchedAt: String(options.fetchedAt || ''),
    message: options.message ? safeMessage(options.message) : '',
  };
  const nextSignature = JSON.stringify(nextState);
  if (nextSignature === recentRequestsSignature) return false;
  recentRequestProviderId = providerId;
  recentRequests = nextRequests;
  recentRequestsLoading = nextState.loading;
  recentRequestsSource = nextState.source;
  recentRequestsPreciseCost = nextState.preciseCost;
  recentRequestsFetchedAt = nextState.fetchedAt;
  recentRequestsMessage = nextState.message;
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
}

function syncRecentRequests(providerOverride = undefined, options = {}) {
  try {
    const provider = providerOverride === undefined ? repository.getCurrent() : providerOverride;
    const providerId = String(provider?.id || '');
    if (
      options.force !== true
      && providerId
      && providerId === recentRequestProviderId
      && recentRequestsSource === 'provider_log'
    ) return false;
    const nextRequests = providerId ? repository.getRecentRequests(providerId, RECENT_REQUEST_LIMIT) : [];
    return updateRecentRequestsState(provider, nextRequests, {
      source: 'ccswitch_local',
      preciseCost: false,
      costExact: false,
      costSource: 'ccswitch_local',
      costUnit: 'USD',
      loading: providerId === recentRequestProviderId && recentRequestsLoading,
      fetchedAt: String(nextRequests[0]?.createdAt || ''),
      message: '',
    });
  } catch {
    return false;
  }
}

async function refreshRecentRequests() {
  let provider;
  try {
    provider = repository.getCurrent();
  } catch (error) {
    const payloadProvider = lastPayload?.providerId ? {
      id: lastPayload.providerId,
      name: lastPayload.providerName,
      websiteUrl: lastPayload.websiteUrl,
    } : null;
    updateRecentRequestsState(payloadProvider, recentRequests, {
      source: recentRequestsSource,
      preciseCost: recentRequestsPreciseCost,
      loading: false,
      fetchedAt: recentRequestsFetchedAt,
      message: safeMessage(error),
    });
    requestTargetSync({ audit: true });
    return;
  }
  if (!provider) {
    updateRecentRequestsState(null, [], { message: '没有找到当前 Codex 供应商' });
    lastPayload = payloadWithRecentRequests(lastPayload);
    requestTargetSync({ audit: true });
    return;
  }

  if (String(provider.id) !== recentRequestProviderId) syncRecentRequests(provider, { force: true });
  updateRecentRequestsState(provider, recentRequests, {
    source: recentRequestsSource,
    preciseCost: recentRequestsPreciseCost,
    loading: true,
    fetchedAt: recentRequestsFetchedAt,
    message: '',
  });
  requestTargetSync({ audit: true });

  try {
    const syncResult = syncHubProviders();
    if (!syncResult.succeeded) throw syncResult.error;
    const result = await hubService.queryRequestUsage(provider.id, { limit: RECENT_REQUEST_LIMIT });
    const currentProvider = repository.getCurrent();
    if (!currentProvider || String(currentProvider.id) !== String(provider.id)) return;
    updateRecentRequestsState(provider, result?.items, {
      source: String(result?.source || 'ccswitch_local'),
      preciseCost: result?.preciseCostAvailable === true,
      loading: false,
      fetchedAt: String(result?.fetchedAt || new Date().toISOString()),
      message: String(result?.message || ''),
    });
  } catch (error) {
    try {
      const fallbackRows = repository.getRecentRequests(provider.id, RECENT_REQUEST_LIMIT);
      updateRecentRequestsState(provider, fallbackRows, {
        source: 'ccswitch_local',
        preciseCost: false,
        costExact: false,
        costSource: 'ccswitch_local',
        costUnit: 'USD',
        loading: false,
        fetchedAt: String(fallbackRows[0]?.createdAt || ''),
        message: `第三方逐请求用量查询失败，显示 CCSwitch 本地估算：${safeMessage(error)}`,
      });
    } catch (fallbackError) {
      updateRecentRequestsState(provider, recentRequests, {
        source: recentRequestsSource,
        preciseCost: recentRequestsPreciseCost,
        loading: false,
        fetchedAt: recentRequestsFetchedAt,
        message: `逐请求用量查询失败：${safeMessage(fallbackError || error)}`,
      });
    }
  } finally {
    if (String(provider.id) === recentRequestProviderId && recentRequestsLoading) {
      updateRecentRequestsState(provider, recentRequests, {
        source: recentRequestsSource,
        preciseCost: recentRequestsPreciseCost,
        loading: false,
        fetchedAt: recentRequestsFetchedAt,
        message: recentRequestsMessage,
      });
    }
    requestTargetSync({ audit: true });
  }
}

function requestRecentRequestsRefresh() {
  recentRequestsRefreshPending = true;
  if (recentRequestsRefreshPromise) return recentRequestsRefreshPromise;
  recentRequestsRefreshPromise = (async () => {
    while (recentRequestsRefreshPending && !stopped) {
      recentRequestsRefreshPending = false;
      await refreshRecentRequests();
    }
  })().finally(() => { recentRequestsRefreshPromise = null; });
  return recentRequestsRefreshPromise;
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

function acceptAction(action) {
  const signature = actionSignature(action);
  if (!signature || recentActionSignatures.has(signature)) return false;
  recentActionSignatures.add(signature);
  recentActionSignatureOrder.push(signature);
  while (recentActionSignatureOrder.length > 64) {
    recentActionSignatures.delete(recentActionSignatureOrder.shift());
  }
  return true;
}

async function syncTargets({ audit = true } = {}) {
  const allTargets = await listCdpTargets(args.port);
  const targets = allTargets.filter(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl);
  if (targets.length === 0) {
    mountedPages = 0;
    mountedTargetIds = new Set();
    throw new Error('没有找到 Codex 主页面');
  }

  const targetActions = targets.map(target => ({ target, actions: decodePageActionQueue(target.title) }));
  const markedActions = targetActions.filter(item => item.actions.length > 0);
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
  if (markedActions.length > 0) {
    const acknowledgements = await settleTargetOperations(
      markedActions,
      ({ target }) => acknowledgePageAction(target, target.title),
    );
    const failures = acknowledgements.filter(result => result.status === 'rejected');
    let refreshRequested = false;
    let recentRequestsRequested = false;
    let actionAccepted = false;
    markedActions.forEach((item, index) => {
      if (acknowledgements[index]?.status !== 'fulfilled' || acknowledgements[index].value !== true) return;
      for (const action of item.actions) {
        if (!acceptAction(action)) continue;
        actionAccepted = true;
        if (action.action === 'refresh') {
          refreshRequested = true;
          requestCurrentProviderRefresh(true, true);
        }
        if (action.action === 'refresh-requests') {
          recentRequestsRequested = true;
          requestRecentRequestsRefresh();
        }
        if (action.action === 'open-hub') openHubFromAction();
      }
    });
    mountedPages = targets.length;
    if (actionAccepted) targetInstallBackoff.reset();
    if (failures.length) throw failures[0].reason;
    return {
      installed: false,
      deferred: !refreshRequested && !recentRequestsRequested && actionAccepted && (audit || targetIdentityChanged),
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
  codexProcessMonitor = null;
  databaseWatcher?.close();
  databaseWatcher = null;
  controlWatcher?.close();
  controlWatcher = null;
  mountedPages = 0;
  mountedTargetIds = new Set();
  const auxiliaryShutdown = Promise.allSettled([hubServer.close()]);
  browserBroker.close();
  if (databaseWatchTimer) clearTimeout(databaseWatchTimer);
  if (currentProviderRefreshTimer) clearTimeout(currentProviderRefreshTimer);
  repository.close();
  try { fs.rmSync(pidPath, { force: true }); } catch {}
  const stoppedStatus = {
    running: false,
    pid: null,
    databaseWatch: false,
    controlWatch: false,
    connectedPages: 0,
    hubRunning: false,
    hubPort: null,
    browserCompanion: false,
  };
  const writeStoppedStatus = () => {
    try { writeStatus(stoppedStatus); } catch {}
  };
  writeStoppedStatus();
  auxiliaryShutdown.finally(() => {
    writeStoppedStatus();
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
