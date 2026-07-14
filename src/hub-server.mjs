import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildHubPage } from './hub-page.mjs';
import { isLoopbackRequest } from './edge-session.mjs';

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
    this.port = Number.isFinite(Number(options.port)) ? Number(options.port) : 17893;
    this.token = options.token || getOrCreateHubToken(options.tokenPath);
    this.openUrl = options.openUrl || (url => {
      const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    });
    this.server = null;
    this.boundPort = 0;
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
    if (this.server) return this.url;
    this.server = http.createServer((request, response) => {
      this.#handle(request, response).catch(error => jsonResponse(response, 500, { success: false, message: error.message }));
    });
    await this.#listen(this.port).catch(async error => {
      if (error?.code !== 'EADDRINUSE' || this.port === 0) throw error;
      await this.#listen(0);
    });
    this.boundPort = this.server.address().port;
    return this.url;
  }

  async #listen(port) {
    await new Promise((resolve, reject) => {
      const onError = error => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, '127.0.0.1');
    });
  }

  async #handle(request, response) {
    if (!isLoopbackRequest(request)) {
      jsonResponse(response, 403, { success: false, message: '仅允许本机访问' });
      return;
    }
    const url = new URL(request.url || '/', `http://127.0.0.1:${this.boundPort || 80}`);
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
      this.service.refreshAll().catch(() => {});
      return;
    }
    if (request.method === 'GET' && url.pathname === `${this.apiPath}/state`) {
      jsonResponse(response, 200, this.service.getState());
      return;
    }
    if (request.method === 'POST' && url.pathname === `${this.apiPath}/refresh`) {
      const body = await readBody(request);
      const operation = body.providerId ? this.service.refreshProvider(body.providerId) : this.service.refreshAll();
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
    this.service.refreshAll().catch(() => {});
    return this.url;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    await new Promise(resolve => server.close(resolve));
  }
}
