import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildHubPage } from './hub-page.mjs';

function isLoopbackRequest(request) {
  const value = request?.socket?.remoteAddress || '';
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

export function isAllowedHubHost(value, port) {
  const authority = String(value || '').trim().toLowerCase();
  const expectedPort = Number(port);
  if (!authority || !Number.isInteger(expectedPort) || expectedPort <= 0) return false;
  try {
    const url = new URL(`http://${authority}`);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const actualPort = url.port ? Number(url.port) : 80;
    return ['127.0.0.1', 'localhost', '::1'].includes(hostname)
      && actualPort === expectedPort
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function readBody(request, maximumBytes = 16_384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('请求 JSON 无效')); }
    });
    request.on('error', reject);
  });
}

function jsonResponse(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function getOrCreateHubToken(tokenPath) {
  if (!tokenPath) return crypto.randomBytes(24).toString('base64url');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export class HubServer {
  constructor(service, options = {}) {
    this.service = service;
    this.browserBroker = options.browserBroker || null;
    this.port = Number.isFinite(Number(options.port)) ? Number(options.port) : 17891;
    this.token = options.token || getOrCreateHubToken(options.tokenPath);
    this.openUrl = options.openUrl || (url => {
      const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    });
    this.server = null;
    this.boundPort = 0;
    this.startPromise = null;
  }

  get pagePath() {
    return `/hub/${this.token}`;
  }

  get apiPath() {
    return `/api/${this.token}`;
  }

  get url() {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}${this.pagePath}` : '';
  }

  async start() {
    if (this.server?.listening && this.boundPort) return this.url;
    if (this.startPromise) return this.startPromise;
    const startPromise = (async () => {
      const server = http.createServer((request, response) => {
        this.#handle(request, response).catch(error => {
          if (response.destroyed || response.writableEnded) return;
          jsonResponse(response, 500, { success: false, message: error.message });
        });
      });
      this.server = server;
      try {
        await this.#listen(server, this.port);
        this.boundPort = server.address().port;
        return this.url;
      } catch (error) {
        if (this.server === server) this.server = null;
        this.boundPort = 0;
        try { server.close(); } catch {}
        throw error;
      }
    })();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async #listen(server, port) {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  async #handle(request, response) {
    if (!isLoopbackRequest(request)) {
      jsonResponse(response, 403, { success: false, message: '仅允许本机访问' });
      return;
    }
    if (!isAllowedHubHost(request.headers.host, this.boundPort || this.port)) {
      jsonResponse(response, 403, { success: false, message: 'Host 不在本机允许列表中' });
      return;
    }
    const url = new URL(request.url || '/', `http://127.0.0.1:${this.boundPort || 80}`);
    const crossSite = String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site';
    if (crossSite && (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/usage/'))) {
      jsonResponse(response, 403, { success: false, message: 'Cross-site browser requests are not allowed' });
      return;
    }
    if (request.method === 'GET' && ['/', '/health', '/v1/health'].includes(url.pathname)) {
      const state = this.service.getState();
      jsonResponse(response, 200, {
        success: true,
        service: 'codex-ccswitch-balance-hub',
        version: 2,
        providers: state.providers.length,
        refreshing: state.refreshing,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/providers') {
      jsonResponse(response, 200, { success: true, providers: this.service.listPublicProviders() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/balances') {
      jsonResponse(response, 200, this.service.getAllBalances());
      return;
    }
    const cachedBalanceMatch = url.pathname.match(/^\/v1\/balance\/([^/]+)$/);
    if (request.method === 'GET' && cachedBalanceMatch) {
      const selector = decodeURIComponent(cachedBalanceMatch[1]);
      jsonResponse(response, 200, this.service.getBalance(selector));
      return;
    }
    const legacyBalanceMatch = url.pathname.match(/^\/usage\/([^/]+)$/);
    if (request.method === 'GET' && legacyBalanceMatch) {
      const selector = decodeURIComponent(legacyBalanceMatch[1]);
      jsonResponse(response, 200, await this.service.queryBalance(selector));
      return;
    }
    if (request.method === 'GET' && url.pathname === this.pagePath) {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const body = Buffer.from(buildHubPage({ apiBase: this.apiPath, nonce }));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && url.pathname === `${this.apiPath}/state`) {
      jsonResponse(response, 200, {
        ...this.service.getState(),
        companion: this.browserBroker?.getStatus?.() || { connected: false, clients: [], queuedJobs: 0, pendingJobs: 0 },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === `${this.apiPath}/companion/heartbeat`) {
      if (!this.browserBroker) throw new Error('浏览器伴侣回调未启用');
      const body = await readBody(request);
      jsonResponse(response, 200, { success: true, companion: this.browserBroker.heartbeat(body) });
      return;
    }
    if (request.method === 'POST' && url.pathname === `${this.apiPath}/companion/session`) {
      if (!this.browserBroker) throw new Error('浏览器伴侣回调未启用');
      const body = await readBody(request);
      const accepted = this.browserBroker.noteSession(body.clientId, body.origin);
      jsonResponse(response, accepted ? 200 : 400, { success: accepted });
      return;
    }
    if (request.method === 'GET' && url.pathname === `${this.apiPath}/companion/job`) {
      if (!this.browserBroker) throw new Error('浏览器伴侣回调未启用');
      const sessions = url.searchParams.has('sessionsKnown') || url.searchParams.has('session')
        ? url.searchParams.getAll('session')
        : undefined;
      const pollController = new AbortController();
      const abortPoll = () => pollController.abort();
      const closePoll = () => {
        if (!response.writableEnded) abortPoll();
      };
      request.once('aborted', abortPoll);
      response.once('close', closePoll);
      let job;
      try {
        job = await this.browserBroker.nextJob({
          clientId: url.searchParams.get('clientId'),
          instanceId: url.searchParams.get('instanceId'),
          browser: url.searchParams.get('browser'),
          version: url.searchParams.get('version'),
          protocolVersion: url.searchParams.get('protocolVersion'),
          capabilities: url.searchParams.getAll('capability'),
          sessions,
        }, 25_000, { signal: pollController.signal });
      } finally {
        request.off('aborted', abortPoll);
        response.off('close', closePoll);
      }
      if (pollController.signal.aborted || response.destroyed) return;
      if (!job) {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
      } else {
        jsonResponse(response, 200, { success: true, job });
      }
      return;
    }
    const companionResultMatch = url.pathname.match(new RegExp(`^${this.apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/companion/result/([^/]+)$`));
    if (request.method === 'POST' && companionResultMatch) {
      if (!this.browserBroker) throw new Error('浏览器伴侣回调未启用');
      const body = await readBody(request, 2_100_000);
      const accepted = this.browserBroker.complete(decodeURIComponent(companionResultMatch[1]), body);
      jsonResponse(response, accepted ? 200 : 404, { success: accepted });
      return;
    }
    if (request.method === 'POST' && url.pathname === `${this.apiPath}/refresh`) {
      const body = await readBody(request);
      const providerSelector = String(body.providerId || '').trim();
      let operation;
      if (providerSelector) {
        const provider = this.service.findProvider(providerSelector);
        if (!provider) {
          jsonResponse(response, 404, { success: false, message: 'CCSwitch 中不存在这个 Codex 供应商' });
          return;
        }
        operation = this.service.refreshProvider(provider.id);
      } else {
        operation = this.service.refreshAll();
      }
      operation.catch(() => {});
      jsonResponse(response, 202, { success: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === `${this.apiPath}/login`) {
      const body = await readBody(request);
      const item = await this.service.openLogin(body.providerId);
      jsonResponse(response, 200, { success: true, provider: item });
      return;
    }
    jsonResponse(response, 404, { success: false, message: 'Not found' });
  }

  open() {
    if (!this.url) throw new Error('Balance Hub 尚未启动');
    this.openUrl(this.url);
    return this.url;
  }

  async close() {
    if (this.startPromise) {
      try { await this.startPromise; } catch {}
    }
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    await new Promise(resolve => server.close(resolve));
  }
}
