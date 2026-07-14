import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CdpClient } from './cdp-client.mjs';

const DEFAULT_DEBUG_PORT = 17892;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isLoopbackAddress(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

export function findEdgeExecutable(environment = process.env, existsSync = fs.existsSync) {
  const candidates = [
    environment.PROGRAMFILES ? path.join(environment.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    environment['PROGRAMFILES(X86)'] ? path.join(environment['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || '';
}

export function parseBrowserJson(text) {
  const source = String(text || '').trim();
  if (!source || source.length > 2_000_000) return null;
  try {
    return JSON.parse(source);
  } catch {
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try { return JSON.parse(source.slice(firstBrace, lastBrace + 1)); } catch {}
    return null;
  }
}

export class EdgeSession {
  constructor(profileDir, options = {}) {
    this.profileDir = profileDir;
    this.port = Number(options.port) || DEFAULT_DEBUG_PORT;
    this.edgeExecutable = options.edgeExecutable || findEdgeExecutable();
    this.fetchImpl = options.fetchImpl || fetch;
    this.spawnImpl = options.spawnImpl || spawn;
    this.connectImpl = options.connectImpl || CdpClient.connect;
    this.existsSync = options.existsSync || fs.existsSync;
    this.loginStatePath = options.loginStatePath || path.join(this.profileDir, 'hub-login-sites.json');
    this.mode = '';
    this.launchPromise = null;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  hasPersistentState() {
    return [
      path.join(this.profileDir, 'Default', 'Network', 'Cookies'),
      path.join(this.profileDir, 'Default', 'Cookies'),
      path.join(this.profileDir, 'Default', 'Local Storage'),
    ].some(candidate => this.existsSync(candidate));
  }

  hasLoginState(url) {
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { return false; }
    try {
      const state = JSON.parse(fs.readFileSync(this.loginStatePath, 'utf8'));
      return Boolean(state?.[hostname]);
    } catch {
      return false;
    }
  }

  noteLoginOpened(url) {
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { return false; }
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.loginStatePath, 'utf8')) || {}; } catch {}
    state[hostname] = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.loginStatePath), { recursive: true });
    const temporary = `${this.loginStatePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.loginStatePath);
    return true;
  }

  async getVersion(timeoutMs = 1_000) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      if (!response.ok) return null;
      const version = await response.json();
      return version?.webSocketDebuggerUrl ? version : null;
    } catch {
      return null;
    }
  }

  async closeBrowser() {
    const version = await this.getVersion();
    if (!version) return false;
    let client;
    try {
      client = await this.connectImpl(version.webSocketDebuggerUrl, 3_000);
      await client.call('Browser.close', {}, 5_000);
    } catch {
      return false;
    } finally {
      client?.close();
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!await this.getVersion(300)) break;
      await delay(100);
    }
    this.mode = '';
    return true;
  }

  async closeIfHeadless() {
    const version = await this.getVersion();
    const headless = this.mode === 'headless' || /HeadlessChrome/i.test(String(version?.['User-Agent'] || ''));
    return headless ? this.closeBrowser() : false;
  }

  async ensureBrowser({ visible = false, initialUrl = 'about:blank' } = {}) {
    const active = await this.getVersion();
    const activeIsHeadless = this.mode === 'headless' || /HeadlessChrome/i.test(String(active?.['User-Agent'] || ''));
    if (active && (!visible || !activeIsHeadless)) return active;
    if (active && visible && activeIsHeadless) await this.closeBrowser();
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.#launch({ visible, initialUrl }).finally(() => { this.launchPromise = null; });
    return this.launchPromise;
  }

  async #launch({ visible, initialUrl }) {
    if (!this.edgeExecutable) throw new Error('未找到 Microsoft Edge，无法建立网页登录会话');
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.profileDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--disable-background-mode',
    ];
    if (visible) {
      args.push('--new-window');
    } else {
      args.push('--headless=new', '--disable-gpu');
    }
    args.push(initialUrl);
    const child = this.spawnImpl(this.edgeExecutable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: !visible,
    });
    child.unref?.();
    this.mode = visible ? 'visible' : 'headless';
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const version = await this.getVersion(500);
      if (version) return version;
      await delay(150);
    }
    this.mode = '';
    throw new Error('Microsoft Edge 网页会话启动超时');
  }

  async createTarget(url = 'about:blank') {
    await this.ensureBrowser({ visible: false });
    const response = await this.fetchImpl(`${this.baseUrl}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Edge 调试接口返回 HTTP ${response.status}`);
    const target = await response.json();
    if (!target?.webSocketDebuggerUrl || !target?.id) throw new Error('Edge 调试接口没有返回页面目标');
    return target;
  }

  async closeTarget(targetId) {
    if (!targetId) return;
    try {
      await this.fetchImpl(`${this.baseUrl}/json/close/${encodeURIComponent(targetId)}`, {
        signal: AbortSignal.timeout(1_500),
      });
    } catch {}
  }

  async openLogin(url) {
    if (!/^https:\/\//i.test(String(url || ''))) throw new Error('登录地址必须使用 HTTPS');
    await this.ensureBrowser({ visible: true, initialUrl: url });
    const target = await this.createTarget(url);
    const client = await this.connectImpl(target.webSocketDebuggerUrl, 5_000);
    try {
      await client.call('Page.bringToFront', {}, 5_000);
      this.noteLoginOpened(url);
    } finally {
      client.close();
    }
    return { success: true, url };
  }

  async queryJson({
    baseUrl,
    requestPath,
    headers = {},
    userHeader = '',
    navigateRequest = false,
    waitMs = 35_000,
  }) {
    const origin = new URL(baseUrl);
    if (origin.protocol !== 'https:') throw new Error('网页登录查询只允许 HTTPS 站点');
    const target = await this.createTarget(origin.origin);
    const client = await this.connectImpl(target.webSocketDebuggerUrl, 5_000);
    try {
      await Promise.all([
        client.call('Page.enable', {}, 5_000),
        client.call('Runtime.enable', {}, 5_000),
        client.call('Network.enable', {}, 5_000),
      ]);
      await client.call('Page.navigate', { url: origin.origin }, 5_000);
      await this.#waitForReady(client, Math.min(waitMs, 20_000));

      const outgoing = { Accept: 'application/json', ...headers };
      if (userHeader && !outgoing[userHeader]) {
        const userId = await client.evaluate(`(() => {
          try { return String(JSON.parse(localStorage.getItem('user') || '{}').id || ''); }
          catch { return ''; }
        })()`);
        if (userId) outgoing[userHeader] = userId;
      }

      const url = new URL(requestPath || '/', origin.origin).href;
      if (navigateRequest) {
        await client.call('Network.setExtraHTTPHeaders', { headers: outgoing }, 5_000);
        await client.call('Page.navigate', { url }, 5_000);
        return await this.#waitForJsonBody(client, waitMs);
      }

      return await client.evaluate(`(async () => {
        const response = await fetch(${JSON.stringify(url)}, {
          method: 'GET', credentials: 'include', cache: 'no-store', headers: ${JSON.stringify(outgoing)}
        });
        const text = (await response.text()).slice(0, 2000000);
        return { status: response.status, url: response.url, text };
      })()`);
    } finally {
      client.close();
      await this.closeTarget(target.id);
    }
  }

  async #waitForReady(client, waitMs) {
    const deadline = Date.now() + Math.max(1_000, waitMs);
    while (Date.now() < deadline) {
      try {
        const ready = await client.evaluate(`document.readyState === 'interactive' || document.readyState === 'complete'`);
        if (ready) return true;
      } catch {}
      await delay(250);
    }
    return false;
  }

  async #waitForJsonBody(client, waitMs) {
    const deadline = Date.now() + Math.max(1_000, waitMs);
    let last = { status: 0, url: '', text: '' };
    while (Date.now() < deadline) {
      try {
        last = await client.evaluate(`({
          status: 200,
          url: location.href,
          text: String(document.body?.innerText || '').slice(0, 2000000)
        })()`);
        if (parseBrowserJson(last?.text)) return last;
      } catch {}
      await delay(500);
    }
    return last;
  }
}

export function isLoopbackRequest(request) {
  return isLoopbackAddress(request?.socket?.remoteAddress || '');
}
