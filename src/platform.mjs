import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';

function pathForPlatform(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function getHomeDir(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME', 'USERPROFILE'];
  for (const name of names) {
    const value = String(env?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function getDefaultDatabasePath(env = process.env, cwd = process.cwd(), platform = process.platform) {
  return pathForPlatform(platform).join(getHomeDir(env, platform) || cwd, '.cc-switch', 'cc-switch.db');
}

export function getCodexHomeDir(env = process.env, platform = process.platform) {
  const configured = String(env?.CODEX_HOME || '').trim();
  if (configured) return configured;
  const home = getHomeDir(env, platform);
  return home ? pathForPlatform(platform).join(home, '.codex') : '';
}

export function getOpenCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [] };
  return { command: 'xdg-open', args: [] };
}

export function openExternalUrl(value, {
  platform = process.platform,
  spawnFn = defaultSpawn,
} = {}) {
  const url = String(value || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('外部链接无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('外部链接协议不受支持');
  }

  const opener = getOpenCommand(platform);
  const options = { detached: true, stdio: 'ignore' };
  if (platform === 'win32') options.windowsHide = true;
  const child = spawnFn(opener.command, [...opener.args, url], options);
  child?.unref?.();
  return child;
}
