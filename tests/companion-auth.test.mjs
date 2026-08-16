import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildCompanionAuth, verifyCompanionResponse } from '../browser-companion/auth.js';
import { CompanionAuthenticator, signCompanionRequest } from '../src/companion-auth.mjs';

const TOKEN = 'companion-test-token-0000000000000001';

function request(headers, method = 'POST') {
  return { method, headers };
}

test('browser and host companion authentication implementations share one canonical protocol', async () => {
  const target = '/companion/v3/heartbeat';
  const body = JSON.stringify({ clientId: 'edge-client-one' });
  const now = 1_800_000_000_000;
  const signed = await buildCompanionAuth(TOKEN, {
    method: 'POST', target, body, now, nonce: 'browser-nonce-000000000001',
  });
  const authenticator = new CompanionAuthenticator(TOKEN, { now: () => now });
  assert.deepEqual(
    authenticator.verifyRequest(request(signed.headers), new URL(`http://127.0.0.1${target}`), Buffer.from(body)),
    { nonce: 'browser-nonce-000000000001', timestamp: now },
  );
});

test('companion authentication rejects tampering, replay, and expired requests', () => {
  const target = '/companion/v3/heartbeat';
  const now = 1_800_000_000_000;
  const authenticator = new CompanionAuthenticator(TOKEN, { now: () => now });
  const valid = signCompanionRequest(TOKEN, {
    method: 'POST', target, body: '{}', timestamp: now, nonce: 'host-nonce-000000000000001',
  });
  const url = new URL(`http://127.0.0.1${target}`);
  authenticator.verifyRequest(request(valid.headers), url, Buffer.from('{}'));
  assert.throws(() => authenticator.verifyRequest(request(valid.headers), url, Buffer.from('{}')), /随机数已使用/);

  const tampered = signCompanionRequest(TOKEN, {
    method: 'POST', target, body: '{}', timestamp: now, nonce: 'host-nonce-000000000000002',
  });
  assert.throws(() => authenticator.verifyRequest(request(tampered.headers), url, Buffer.from('{"changed":true}')), /签名无效/);

  const expired = signCompanionRequest(TOKEN, {
    method: 'POST', target, body: '{}', timestamp: now - 60_001, nonce: 'host-nonce-000000000000003',
  });
  assert.throws(() => authenticator.verifyRequest(request(expired.headers), url, Buffer.from('{}')), /已过期/);
});

test('companion request signature cannot be forged with a different pairing secret', () => {
  const now = Date.now();
  const target = '/companion/v3/job?clientId=edge-client-one';
  const signed = signCompanionRequest('different-test-token-0000000000000001', {
    method: 'GET', target, timestamp: now, nonce: crypto.randomBytes(18).toString('base64url'),
  });
  const authenticator = new CompanionAuthenticator(TOKEN, { now: () => now });
  assert.throws(() => authenticator.verifyRequest(request(signed.headers, 'GET'), new URL(`http://127.0.0.1${target}`)), /签名无效/);
});

test('browser verifies that a Hub response is bound to its request, status, and body', async () => {
  const now = 1_800_000_000_000;
  const requestNonce = 'browser-request-nonce-000001';
  const body = JSON.stringify({ success: true });
  const authenticator = new CompanionAuthenticator(TOKEN, { now: () => now });
  const headers = new Headers(authenticator.signResponse(requestNonce, 200, Buffer.from(body)));

  await assert.doesNotReject(verifyCompanionResponse(TOKEN, {
    requestNonce, status: 200, body, headers, now,
  }));
  await assert.rejects(verifyCompanionResponse(TOKEN, {
    requestNonce, status: 201, body, headers, now,
  }), /签名验证失败/);
  await assert.rejects(verifyCompanionResponse(TOKEN, {
    requestNonce, status: 200, body: '{"success":false}', headers, now,
  }), /签名验证失败/);
});
