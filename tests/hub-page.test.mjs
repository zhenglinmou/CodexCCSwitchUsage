import assert from 'node:assert/strict';
import test from 'node:test';
import { hubLoginLink } from '../src/hub-page.mjs';

test('browser providers always retain an official login link across quota states', () => {
  const base = { loginUrl: 'https://anyrouter.top/login', websiteUrl: '' };
  for (const status of ['ok', 'degraded', 'error', 'login-required']) {
    const link = hubLoginLink({ ...base, status });
    assert.equal(link.href, 'https://anyrouter.top/login');
    assert.equal(link.label, status === 'ok' ? '官网登录' : '重新登录官网');
  }
});

test('session synchronization remains separate from the always-available official login link', () => {
  const link = hubLoginLink({
    loginUrl: 'https://agentrouter.org/login',
    status: 'login-required',
    sessionSyncRequired: true,
  });
  assert.deepEqual(link, {
    href: 'https://agentrouter.org/login',
    label: '官网登录',
    primary: false,
  });
});

test('official login links reject non-HTTPS and credential-bearing URLs', () => {
  assert.equal(hubLoginLink({ loginUrl: 'http://anyrouter.top/login' }), null);
  assert.equal(hubLoginLink({ loginUrl: 'https://user:password@anyrouter.top/login' }), null);
});
