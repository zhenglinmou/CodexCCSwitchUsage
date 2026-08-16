import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../src/process-lifecycle.mjs';
import { listLocalProcesses } from './launch.mjs';
import { secureAtomicWriteFileSync } from '../src/secure-files.mjs';

const MAX_PACKAGE_MARKER_BYTES = 65_536;
const MAX_PID_FILE_BYTES = 64;
const MAX_STATUS_FILE_BYTES = 1_000_000;

function parseArgs(argv) {
  const result = { installRoot: process.cwd(), runtimeDir: '', timeoutMs: 5_000, port: 0, allInstances: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--install-root') { result.installRoot = value; index += 1; }
    else if (option === '--runtime-dir') { result.runtimeDir = value; index += 1; }
    else if (option === '--timeout-ms') { result.timeoutMs = Number(value); index += 1; }
    else if (option === '--port') { result.port = Number(value); index += 1; }
    else if (option === '--all-instances') result.allInstances = true;
    else if (option === '--help' || option === '-h') result.help = true;
    else throw new Error(`未知参数: ${option}`);
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65_535) throw new Error('CDP 端口无效');
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs < 250) throw new Error('停止超时无效');
  if (result.runtimeDir === '' && argv.includes('--runtime-dir')) throw new Error('runtime 目录不能为空');
  return result;
}

function readPid(filename) {
  try {
    const stats = fs.statSync(filename);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PID_FILE_BYTES) return 0;
    const value = Number.parseInt(fs.readFileSync(filename, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function commandTokens(commandLine) {
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of String(commandLine || '').matchAll(pattern)) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\"/g, '"'));
  }
  return tokens;
}

function optionValue(tokens, option) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === option) return tokens[index + 1] || '';
    if (tokens[index].startsWith(`${option}=`)) return tokens[index].slice(option.length + 1);
  }
  return '';
}

function trustedHostRoot(hostPath) {
  if (!path.isAbsolute(hostPath) || path.basename(hostPath) !== 'host.mjs' || path.basename(path.dirname(hostPath)) !== 'src') return '';
  const root = path.dirname(path.dirname(hostPath));
  try {
    const markerPath = path.join(root, 'package.json');
    const stats = fs.statSync(markerPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PACKAGE_MARKER_BYTES) return '';
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker?.name === 'codex-ccswitch-usage' && fs.statSync(hostPath).isFile() ? root : '';
  } catch {
    return '';
  }
}

export function inspectHostProcess(processInfo, { expectedHostPath = '', port = 0, allInstances = false } = {}) {
  if (!processInfo?.commandLine || !Number.isInteger(Number(processInfo.pid)) || Number(processInfo.pid) <= 0) return null;
  const tokens = commandTokens(processInfo.commandLine);
  const rawHostPath = tokens.find(token => /(?:^|[\\/])src[\\/]host\.mjs$/.test(token));
  if (!rawHostPath) return null;
  const hostPath = path.resolve(rawHostPath);
  if (!allInstances && path.resolve(expectedHostPath) !== hostPath) return null;
  if (Number(port) > 0 && Number(optionValue(tokens, '--port')) !== Number(port)) return null;
  const root = trustedHostRoot(hostPath);
  if (!root) return null;
  const runtimeOption = optionValue(tokens, '--runtime-dir');
  return {
    pid: Number(processInfo.pid),
    root,
    hostPath,
    runtimeDir: runtimeOption && path.isAbsolute(runtimeOption) ? path.resolve(runtimeOption) : path.join(root, 'runtime'),
  };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  return !isProcessAlive(pid);
}

async function terminate(pid, timeoutMs) {
  if (!isProcessAlive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  if (await waitForExit(pid, timeoutMs)) return true;
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  return waitForExit(pid, 1_000);
}

function markStopped(runtimeDir) {
  const pidPath = path.join(runtimeDir, 'host.pid');
  const statusPath = path.join(runtimeDir, 'status.json');
  try { fs.rmSync(pidPath, { force: true }); } catch {}
  let status;
  try {
    const stats = fs.statSync(statusPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_STATUS_FILE_BYTES) return;
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch { return; }
  const next = {
    ...status,
    running: false,
    pid: null,
    databaseWatch: false,
    controlWatch: false,
    connectedPages: 0,
    hubRunning: false,
    hubPort: null,
    browserCompanion: false,
    updatedAt: new Date().toISOString(),
    stopReason: 'Stopped by stop-host.mjs',
  };
  try {
    secureAtomicWriteFileSync(statusPath, JSON.stringify(next, null, 2), { encoding: 'utf8' });
  } catch {}
}

export async function stopHost({
  installRoot = process.cwd(),
  timeoutMs = 5_000,
  port = 0,
  allInstances = false,
  runtimeDir = '',
  platform = process.platform,
  execFileSyncFn = execFileSync,
} = {}) {
  if (platform === 'win32') throw new Error('Windows 请使用 scripts\\stop-host.ps1');
  const root = path.resolve(installRoot);
  const markerPath = path.join(root, 'package.json');
  const markerStats = fs.statSync(markerPath);
  if (!markerStats.isFile() || markerStats.size <= 0 || markerStats.size > MAX_PACKAGE_MARKER_BYTES) {
    throw new Error(`扩展目录不匹配: ${root}`);
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker?.name !== 'codex-ccswitch-usage') throw new Error(`扩展目录不匹配: ${root}`);
  const resolvedRuntimeDir = runtimeDir ? path.resolve(runtimeDir) : path.join(root, 'runtime');
  const hostPath = path.join(root, 'src', 'host.mjs');
  const processes = listLocalProcesses({ platform, execFileSyncFn });
  const recordedPid = readPid(path.join(resolvedRuntimeDir, 'host.pid'));
  const candidates = new Map();
  const recorded = processes.find(processInfo => processInfo.pid === recordedPid);
  const recordedCandidate = inspectHostProcess(recorded, { expectedHostPath: hostPath, port, allInstances: false });
  if (recordedCandidate) candidates.set(recordedPid, recordedCandidate);
  for (const processInfo of processes) {
    const candidate = inspectHostProcess(processInfo, { expectedHostPath: hostPath, port, allInstances });
    if (candidate) candidates.set(candidate.pid, candidate);
  }
  let stopped = 0;
  for (const [pid, candidate] of candidates) {
    if (await terminate(pid, timeoutMs)) {
      stopped += 1;
      markStopped(candidate.runtimeDir);
    }
  }
  if (candidates.size === 0 || [...candidates.keys()].every(pid => !isProcessAlive(pid))) markStopped(resolvedRuntimeDir);
  return { stopped: true, hostCount: stopped, installRoot: root, allInstances: Boolean(allInstances) };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log('node scripts/stop-host.mjs [--install-root PATH] [--runtime-dir PATH] [--all-instances] [--timeout-ms 5000]');
  else stopHost(args).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
