import assert from 'node:assert/strict';
import test from 'node:test';
import { isProcessAlive, ProcessExitMonitor } from '../src/process-lifecycle.mjs';

test('process liveness treats a missing PID as exited and access denial as still alive', () => {
  const fail = code => () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };

  assert.equal(isProcessAlive(123, () => {}), true);
  assert.equal(isProcessAlive(123, fail('EPERM')), true);
  assert.equal(isProcessAlive(123, fail('ESRCH')), false);
  assert.equal(isProcessAlive(0, () => {}), false);
});

test('process exit monitor notifies once and releases its timer', () => {
  let alive = true;
  let exits = 0;
  const scheduled = [];
  const cleared = [];
  const monitor = new ProcessExitMonitor({
    processId: 123,
    onExit: () => { exits += 1; },
    isAlive: () => alive,
    setIntervalFn(callback, intervalMs) {
      const timer = { callback, intervalMs };
      scheduled.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { cleared.push(timer); },
  });

  assert.equal(monitor.start(), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, 1_000);
  assert.equal(exits, 0);

  alive = false;
  scheduled[0].callback();
  scheduled[0].callback();
  assert.equal(exits, 1);
  assert.deepEqual(cleared, [scheduled[0]]);
  assert.equal(monitor.start(), false);
});
