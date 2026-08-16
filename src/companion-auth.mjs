import crypto from 'node:crypto';

export const COMPANION_API_PREFIX = '/companion/v3';
export const COMPANION_AUTH_MAX_SKEW_MS = 60_000;

const REQUEST_DOMAIN = 'CCSWITCH-COMPANION-REQUEST-V1';
const RESPONSE_DOMAIN = 'CCSWITCH-COMPANION-RESPONSE-V1';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function equalSignature(left, right) {
  const first = Buffer.from(String(left || ''));
  const second = Buffer.from(String(right || ''));
  return first.length > 0 && first.length === second.length && crypto.timingSafeEqual(first, second);
}

function requestCanonical(method, target, timestamp, nonce, body) {
  return [
    REQUEST_DOMAIN,
    String(method || '').toUpperCase(),
    String(target || ''),
    String(timestamp || ''),
    String(nonce || ''),
    sha256(body),
  ].join('\n');
}

function responseCanonical(requestNonce, status, timestamp, nonce, body) {
  return [
    RESPONSE_DOMAIN,
    String(requestNonce || ''),
    String(status || ''),
    String(timestamp || ''),
    String(nonce || ''),
    sha256(body),
  ].join('\n');
}

export class CompanionAuthenticator {
  constructor(secret, options = {}) {
    this.secret = String(secret || '');
    if (!TOKEN_PATTERN.test(this.secret)) throw new Error('浏览器伴侣配对密钥无效');
    this.now = options.now || Date.now;
    this.maximumSkewMs = Math.max(5_000, Number(options.maximumSkewMs) || COMPANION_AUTH_MAX_SKEW_MS);
    this.maximumNonces = Math.max(128, Math.min(16_384, Number(options.maximumNonces) || 2_048));
    this.nonces = new Map();
  }

  verifyRequest(request, url, body = Buffer.alloc(0)) {
    const timestamp = String(request?.headers?.['x-ccswitch-timestamp'] || '');
    const nonce = String(request?.headers?.['x-ccswitch-nonce'] || '');
    const signature = String(request?.headers?.['x-ccswitch-signature'] || '');
    const timestampMs = Number(timestamp);
    const now = this.now();
    if (!/^\d{10,16}$/.test(timestamp) || !Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > this.maximumSkewMs) {
      throw new Error('浏览器伴侣请求时间戳无效或已过期');
    }
    if (!NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) {
      throw new Error('浏览器伴侣请求签名格式无效');
    }
    this.#prune(now);
    if (this.nonces.has(nonce)) throw new Error('浏览器伴侣请求随机数已使用');
    const target = `${url.pathname}${url.search}`;
    const expected = hmac(this.secret, requestCanonical(request.method, target, timestamp, nonce, body));
    if (!equalSignature(signature, expected)) throw new Error('浏览器伴侣请求签名无效');
    this.nonces.set(nonce, now + this.maximumSkewMs);
    while (this.nonces.size > this.maximumNonces) this.nonces.delete(this.nonces.keys().next().value);
    return { nonce, timestamp: timestampMs };
  }

  signResponse(requestNonce, status, body = Buffer.alloc(0)) {
    if (!NONCE_PATTERN.test(String(requestNonce || ''))) throw new Error('浏览器伴侣响应缺少请求随机数');
    const timestamp = String(Math.trunc(this.now()));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const signature = hmac(this.secret, responseCanonical(requestNonce, status, timestamp, nonce, body));
    return {
      'x-ccswitch-response-timestamp': timestamp,
      'x-ccswitch-response-nonce': nonce,
      'x-ccswitch-response-signature': signature,
    };
  }

  #prune(now) {
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt < now) this.nonces.delete(nonce);
    }
  }
}

export function signCompanionRequest(secret, options = {}) {
  const timestamp = String(Math.trunc(options.timestamp ?? Date.now()));
  const nonce = String(options.nonce || crypto.randomBytes(18).toString('base64url'));
  const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body || ''));
  const signature = hmac(String(secret || ''), requestCanonical(options.method, options.target, timestamp, nonce, body));
  return {
    nonce,
    headers: {
      'x-ccswitch-timestamp': timestamp,
      'x-ccswitch-nonce': nonce,
      'x-ccswitch-signature': signature,
    },
  };
}
