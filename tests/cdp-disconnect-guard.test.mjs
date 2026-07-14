import assert from 'node:assert/strict';
import test from 'node:test';

const module = await import('../src/cdp-disconnect-guard.mjs').catch(() => ({}));
const { CdpDisconnectGuard } = module;

function createTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimer(callback, delay) {
      const token = { callback, delay };
      scheduled.push(token);
      return token;
    },
    clearTimer(token) {
      cleared.push(token);
    },
  };
}

test('disconnect guard coalesces events and expires after three seconds', async () => {
  assert.equal(typeof CdpDisconnectGuard, 'function');
  const timers = createTimers();
  let verifications = 0;
  let expirations = 0;
  const guard = new CdpDisconnectGuard({
    graceMs: 3_000,
    verifyConnection: async () => { verifications += 1; return false; },
    onExpired: () => { expirations += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(guard.notifyDisconnected(), true);
  assert.equal(guard.notifyDisconnected(), false);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 3_000);
  await timers.scheduled[0].callback();

  assert.equal(verifications, 1);
  assert.equal(expirations, 1);
});

test('disconnect guard cancels shutdown when CDP reconnects', async () => {
  assert.equal(typeof CdpDisconnectGuard, 'function');
  const timers = createTimers();
  let verifications = 0;
  let expirations = 0;
  const guard = new CdpDisconnectGuard({
    graceMs: 3_000,
    verifyConnection: async () => { verifications += 1; return false; },
    onExpired: () => { expirations += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  guard.notifyDisconnected();
  assert.equal(guard.notifyConnected(), true);
  await timers.scheduled[0].callback();

  assert.equal(timers.cleared.length, 1);
  assert.equal(verifications, 0);
  assert.equal(expirations, 0);
});

test('disconnect guard keeps the host alive when final CDP verification succeeds', async () => {
  assert.equal(typeof CdpDisconnectGuard, 'function');
  const timers = createTimers();
  let expirations = 0;
  const guard = new CdpDisconnectGuard({
    graceMs: 3_000,
    verifyConnection: async () => true,
    onExpired: () => { expirations += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  guard.notifyDisconnected();
  await timers.scheduled[0].callback();

  assert.equal(expirations, 0);
  assert.equal(guard.notifyDisconnected(), true);
});
