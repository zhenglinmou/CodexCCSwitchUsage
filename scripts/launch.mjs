import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn as defaultSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeCdpHttpClient, isCodexTargetCandidate, listCdpTargets } from '../src/cdp-client.mjs';
import { getDefaultDatabasePath } from '../src/platform.mjs';
import { isProcessAlive } from '../src/process-lifecycle.mjs';
import { secureMkdirSync, secureOpenAppendSync, secureWriteFileSync } from '../src/secure-files.mjs';

const DEFAULT_PORT = 0;
const DEFAULT_CDP_TIMEOUT_MS = 25_000;
const DEFAULT_RUNTIME_DIR_NAME = 'runtime';
const MAX_PACKAGE_MARKER_BYTES = 65_536;
const MAX_PID_FILE_BYTES = 64;

function commandName(commandLine) {
  const match = /^(?:"([^"]+)"|(\S+))/.exec(String(commandLine || ''));
  const first = match?.[1] || match?.[2] || '';
  return String(first).split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

export function parseProcessTable(value) {
  return String(value || '').split(/\r?\n/).map(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    const pid = Number(match[1]);
    const commandLine = match[2].trim();
    if (!Number.isInteger(pid) || pid <= 0 || !commandLine) return null;
    return { pid, commandLine, name: commandName(commandLine) };
  }).filter(Boolean);
}

export function listLocalProcesses({ platform = process.platform, execFileSyncFn = execFileSync } = {}) {
  if (platform === 'win32') throw new Error('Windows 请使用 scripts\\launch.ps1 或 scripts\\stop-host.ps1');
  return parseProcessTable(execFileSyncFn('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }));
}

export function remoteDebuggingPort(commandLine) {
  const match = /(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?=\s|$)/.exec(String(commandLine || ''));
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
}

export function hasLoopbackDebuggingAddress(commandLine) {
  const match = /(?:^|\s)--remote-debugging-address(?:=|\s+)([^\s]+)/.exec(String(commandLine || ''));
  if (!match) return true;
  const address = match[1].replace(/^\[|\]$/g, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '::1'].includes(address);
}

function isCodexProcess(processInfo) {
  const name = String(processInfo?.name || '').toLowerCase();
  const commandLine = String(processInfo?.commandLine || '');
  return ['codex', 'chatgpt'].includes(name)
    || /(?:^|[\\/])(codex|chatgpt)(?:\.exe)?(?:\s|$)/i.test(commandLine);
}

function isCodexRootProcess(processInfo) {
  return remoteDebuggingPort(processInfo?.commandLine) > 0
    && hasLoopbackDebuggingAddress(processInfo?.commandLine)
    && !/(?:^|\s)--type(?:=|\s)/.test(String(processInfo?.commandLine || ''))
    && isCodexProcess(processInfo);
}

export function findCodexRootProcess(processes, port = DEFAULT_PORT) {
  return (Array.isArray(processes) ? processes : []).find(processInfo => (
    isCodexRootProcess(processInfo)
    && (Number(port) === 0 || remoteDebuggingPort(processInfo.commandLine) === Number(port))
  )) || null;
}

export function buildHostArguments({ root, port, codexPid, runtimeDir, databasePath, platform = process.platform }) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  return [
    '--use-env-proxy',
    '--no-warnings',
    '--experimental-sqlite',
    pathModule.join(root, 'src', 'host.mjs'),
    '--port', String(port),
    '--codex-pid', String(codexPid),
    '--runtime-dir', runtimeDir,
    '--database', databasePath,
  ];
}

export function parseLauncherArgs(argv) {
  const result = {
    installRoot: process.cwd(),
    port: DEFAULT_PORT,
    codexPid: 0,
    runtimeDir: '',
    databasePath: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--install-root') { result.installRoot = value; index += 1; }
    else if (option === '--port') { result.port = Number(value); index += 1; }
    else if (option === '--codex-pid') { result.codexPid = Number(value); index += 1; }
    else if (option === '--runtime-dir') { result.runtimeDir = value; index += 1; }
    else if (option === '--database') { result.databasePath = value; index += 1; }
    else if (option === '--help' || option === '-h') result.help = true;
    else throw new Error(`未知参数: ${option}`);
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65_535) throw new Error('CDP 端口无效');
  if (result.codexPid && (!Number.isInteger(result.codexPid) || result.codexPid <= 0)) throw new Error('Codex PID 无效');
  if (result.runtimeDir === '' && argv.includes('--runtime-dir')) throw new Error('runtime 目录不能为空');
  if (result.databasePath === '' && argv.includes('--database')) throw new Error('数据库路径不能为空');
  return result;
}

function normalizeProxyUrl(value, defaultScheme = 'http') {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)
    ? candidate
    : `${defaultScheme}://${candidate}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function readScutilProxy(output) {
  const values = {};
  for (const match of String(output || '').matchAll(/^\s*(HTTP(?:S)?)(Enable|Proxy|Port)\s*:\s*(.*?)\s*$/gmi)) {
    values[`${match[1].toUpperCase()}${match[2]}`] = match[3];
  }
  const result = {};
  for (const scheme of ['HTTP', 'HTTPS']) {
    if (String(values[`${scheme}Enable`] || '') !== '1') continue;
    const host = String(values[`${scheme}Proxy`] || '').trim();
    const port = String(values[`${scheme}Port`] || '').trim();
    if (!host) continue;
    result[scheme.toLowerCase()] = normalizeProxyUrl(port ? `${host}:${port}` : host, scheme.toLowerCase());
  }
  return result;
}

export function buildProxyEnvironment({
  platform = process.platform,
  env = process.env,
  execFileSyncFn = execFileSync,
} = {}) {
  const result = { ...env };
  let httpProxy = normalizeProxyUrl(result.HTTP_PROXY || result.http_proxy);
  let httpsProxy = normalizeProxyUrl(result.HTTPS_PROXY || result.https_proxy);
  if (platform === 'darwin' && !httpProxy && !httpsProxy) {
    try {
      const configured = readScutilProxy(execFileSyncFn('scutil', ['--proxy'], { encoding: 'utf8' }));
      httpProxy = configured.http || configured.https || '';
      httpsProxy = configured.https || configured.http || '';
    } catch {}
  }
  if (!httpProxy) httpProxy = httpsProxy;
  if (!httpsProxy) httpsProxy = httpProxy;
  if (httpProxy) result.HTTP_PROXY = httpProxy;
  if (httpsProxy) result.HTTPS_PROXY = httpsProxy;

  const noProxy = new Set(String(result.NO_PROXY || result.no_proxy || '').split(',').map(value => value.trim()).filter(Boolean));
  for (const localAddress of ['127.0.0.1', 'localhost', '::1']) noProxy.add(localAddress);
  result.NO_PROXY = [...noProxy].join(',');
  return result;
}

function readJsonFile(filename, fallback = null) {
  try {
    const stats = fs.statSync(filename);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PACKAGE_MARKER_BYTES) return fallback;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch { return fallback; }
}

function assertInstallRoot(root) {
  const markerPath = path.join(root, 'package.json');
  const marker = readJsonFile(markerPath);
  if (!marker || marker.name !== 'codex-ccswitch-usage') throw new Error(`扩展尚未安装或目录不匹配: ${root}`);
}

function readPid(filename) {
  const stats = fs.statSync(filename);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PID_FILE_BYTES) return 0;
  const value = Number.parseInt(String(fs.readFileSync(filename, 'utf8')).trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function commandLineHasCodexPid(commandLine, codexPid) {
  const escapedPid = String(codexPid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)--codex-pid(?:=|\\s+)${escapedPid}(?=\\s|$)`).test(String(commandLine || ''));
}

function commandLineHasPort(commandLine, port) {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)--port(?:=|\\s+)${escapedPort}(?=\\s|$)`).test(String(commandLine || ''));
}

function hostMatchesSource(processInfo, hostPath) {
  return Boolean(processInfo?.commandLine && String(processInfo.commandLine).includes(hostPath));
}

async function sleep(delayMs) {
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

export async function waitForCodexPage(port, {
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS,
  pollMs = 300,
  listTargets = listCdpTargets,
  sleepFn = sleep,
} = {}) {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      if (targets.some(target => isCodexTargetCandidate(target) && target.webSocketDebuggerUrl)) return targets;
      lastError = '没有找到 Codex 主页面';
    } catch (error) {
      lastError = String(error?.message || error || 'CDP 不可用');
    }
    await sleepFn(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Codex 调试接口未就绪: ${lastError || '超时'}`);
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(100);
  return !isProcessAlive(pid);
}

async function terminateHost(pid, timeoutMs = 5_000) {
  if (!isProcessAlive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  if (await waitForExit(pid, timeoutMs)) return true;
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  return waitForExit(pid, 1_000);
}

function startHost({ root, runtimeDir, databasePath, port, codexPid, platform = process.platform, spawnFn = defaultSpawn, env = process.env }) {
  secureMkdirSync(runtimeDir);
  const stdoutPath = path.join(runtimeDir, 'host.log');
  const stderrPath = path.join(runtimeDir, 'host-error.log');
  const stdout = secureOpenAppendSync(stdoutPath);
  const stderr = secureOpenAppendSync(stderrPath);
  try {
    const child = spawnFn(process.execPath, buildHostArguments({ root, port, codexPid, runtimeDir, databasePath, platform }), {
      cwd: root,
      detached: true,
      stdio: ['ignore', stdout, stderr],
      env,
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

export async function launch({
  argv = process.argv.slice(2),
  platform = process.platform,
  execFileSyncFn = execFileSync,
  spawnFn = defaultSpawn,
  listTargets = listCdpTargets,
} = {}) {
  if (platform === 'win32') throw new Error('Windows 请使用 scripts\\launch.ps1；此入口用于 macOS/Linux 源码运行');
  const parsed = parseLauncherArgs(argv);
  if (parsed.help) {
    return { help: true, usage: 'node scripts/launch.mjs [--install-root PATH] [--port PORT] [--codex-pid PID] [--runtime-dir PATH] [--database PATH]' };
  }
  const root = path.resolve(parsed.installRoot);
  assertInstallRoot(root);
  const runtimeDir = parsed.runtimeDir ? path.resolve(parsed.runtimeDir) : path.join(root, DEFAULT_RUNTIME_DIR_NAME);
  const databasePath = parsed.databasePath || getDefaultDatabasePath(process.env, process.cwd(), platform);
  const hostPath = path.join(root, 'src', 'host.mjs');

  const processes = listLocalProcesses({ platform, execFileSyncFn });
  const codexRoot = parsed.codexPid > 0
    ? processes.find(processInfo => processInfo.pid === parsed.codexPid && isCodexRootProcess(processInfo))
    : findCodexRootProcess(processes, parsed.port);
  if (!codexRoot?.pid || !isProcessAlive(codexRoot.pid)) {
    throw new Error('找不到启用 CDP 的 Codex 根进程；请先以随机回环端口启动 Codex，或使用 --codex-pid 显式指定。');
  }
  const detectedPort = remoteDebuggingPort(codexRoot.commandLine);
  if (parsed.port > 0 && detectedPort !== parsed.port) throw new Error('指定的 CDP 端口与 Codex 根进程不一致。');
  const port = parsed.port || detectedPort;
  try {
    await waitForCodexPage(port, { listTargets });
  } finally {
    closeCdpHttpClient();
  }

  secureMkdirSync(runtimeDir);
  secureWriteFileSync(path.join(runtimeDir, 'cdp-port'), String(port), { encoding: 'ascii' });
  const pidPath = path.join(runtimeDir, 'host.pid');
  const recordedPid = fs.existsSync(pidPath) ? readPid(pidPath) : 0;
  const recordedProcess = recordedPid ? processes.find(processInfo => processInfo.pid === recordedPid) : null;
  if (recordedProcess && hostMatchesSource(recordedProcess, hostPath)) {
    if (!commandLineHasCodexPid(recordedProcess.commandLine, codexRoot.pid) || !commandLineHasPort(recordedProcess.commandLine, port)) {
      if (!await terminateHost(recordedPid)) throw new Error(`旧插件宿主未能退出: ${recordedPid}`);
    }
    else {
      secureWriteFileSync(path.join(runtimeDir, 'remount.request'), new Date().toISOString(), { encoding: 'ascii' });
      return { launched: true, reused: true, port, codexProcessId: codexRoot.pid, hostProcessId: recordedPid, installRoot: root };
    }
  }

  const hostProcessId = startHost({
    root,
    runtimeDir,
    databasePath,
    port,
    codexPid: codexRoot.pid,
    platform,
    spawnFn,
    env: buildProxyEnvironment({ platform, execFileSyncFn }),
  });
  secureWriteFileSync(path.join(runtimeDir, 'remount.request'), new Date().toISOString(), { encoding: 'ascii' });
  return { launched: true, reused: false, port, codexProcessId: codexRoot.pid, hostProcessId, installRoot: root };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  launch().then(result => {
    if (result.help) console.log(result.usage);
    else console.log(JSON.stringify(result));
  }).catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
