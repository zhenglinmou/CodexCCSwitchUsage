import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentProviderRefreshIntervalMs,
  RecentRequestInterestTracker,
} from '../src/host-scheduling.mjs';

test('current-provider refresh interval follows the bounded provider preference', () => {
  assert.equal(currentProviderRefreshIntervalMs({ usage: { autoQueryInterval: 15 } }), 15 * 60_000);
  assert.equal(currentProviderRefreshIntervalMs({ usage: { autoQueryInterval: 0.25 } }), 60_000);
  assert.equal(currentProviderRefreshIntervalMs({ usage: { autoQueryInterval: 10_000 } }), 24 * 60 * 60_000);
  assert.equal(currentProviderRefreshIntervalMs({ usage: { autoQueryInterval: 'invalid' } }), 300_000);
});

test('recent-request interest is target-scoped, removable, and self-expiring', () => {
  let now = 1_000;
  const tracker = new RecentRequestInterestTracker({ now: () => now, ttlMs: 5_000 });

  tracker.open('target-one');
  tracker.open('target-two');
  assert.equal(tracker.active(), true);

  tracker.close('target-one');
  assert.equal(tracker.active(), true);
  tracker.retain(new Set(['target-one']));
  assert.equal(tracker.active(), false);

  tracker.open('target-three');
  now += 5_000;
  assert.equal(tracker.active(), false);
});
