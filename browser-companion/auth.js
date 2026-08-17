const REQUEST_DOMAIN = 'CCSWITCH-COMPANION-REQUEST-V1';
const RESPONSE_DOMAIN = 'CCSWITCH-COMPANION-RESPONSE-V1';
const MAXIMUM_SKEW_MS = 60_000;

const encoder = new TextEncoder();
let cachedSecret = '';
let cachedKeyPromise = null;

function bytes(value) {
  return encoder.encode(String(value || ''));
}

function hex(value) {
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(value) {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', bytes(value)));
}

async function key(secret) {
  const value = String(secret || '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new Error('Hub 连接码格式无效');
  if (value === cachedSecret && cachedKeyPromise) return cachedKeyPromise;
  const operation = crypto.subtle.importKey(
    'raw',
    bytes(value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  cachedSecret = value;
  cachedKeyPromise = operation;
  try {
    return await operation;
  } catch (error) {
    if (cachedKeyPromise === operation) {
      cachedSecret = '';
      cachedKeyPromise = null;
    }
    throw error;
  }
}

async function requestCanonical(method, target, timestamp, nonce, body) {
  return [REQUEST_DOMAIN, String(method).toUpperCase(), target, timestamp, nonce, await sha256(body)].join('\n');
}

async function responseCanonical(requestNonce, status, timestamp, nonce, body) {
  return [RESPONSE_DOMAIN, requestNonce, String(status), timestamp, nonce, await sha256(body)].join('\n');
}

export async function buildCompanionAuth(secret, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const target = String(options.target || '');
  const timestamp = String(Math.trunc(options.now ?? Date.now()));
  const nonce = String(options.nonce || base64Url(crypto.getRandomValues(new Uint8Array(18))));
  const body = String(options.body || '');
  const signingKey = await key(secret);
  const signature = base64Url(await crypto.subtle.sign('HMAC', signingKey, bytes(await requestCanonical(method, target, timestamp, nonce, body))));
  return {
    nonce,
    headers: {
      'x-ccswitch-timestamp': timestamp,
      'x-ccswitch-nonce': nonce,
      'x-ccswitch-signature': signature,
    },
  };
}

export async function verifyCompanionResponse(secret, options = {}) {
  const timestamp = String(options.headers?.get?.('x-ccswitch-response-timestamp') || '');
  const nonce = String(options.headers?.get?.('x-ccswitch-response-nonce') || '');
  const signature = String(options.headers?.get?.('x-ccswitch-response-signature') || '');
  const timestampMs = Number(timestamp);
  if (!/^\d{10,16}$/.test(timestamp) || !Number.isSafeInteger(timestampMs) || Math.abs((options.now ?? Date.now()) - timestampMs) > MAXIMUM_SKEW_MS) {
    throw new Error('Balance Hub 响应时间戳无效或已过期');
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[A-Za-z0-9_-]{43,128}$/.test(signature)) {
    throw new Error('Balance Hub 响应缺少有效签名');
  }
  const signingKey = await key(secret);
  const canonical = await responseCanonical(
    String(options.requestNonce || ''),
    Number(options.status),
    timestamp,
    nonce,
    String(options.body || ''),
  );
  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', signingKey, fromBase64Url(signature), bytes(canonical));
  } catch {}
  if (!valid) throw new Error('Balance Hub 响应签名验证失败');
  return true;
}
