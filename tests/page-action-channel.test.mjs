import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePageActionQueue,
  decodePageActionMarker,
  enqueuePageActionTitle,
  encodePageActionMarker,
  encodePageActionQueue,
  PAGE_ACTION_SENTINEL,
  stripPageActionMarker,
} from '../src/page-action-channel.mjs';

test('page actions round-trip through an invisible document-title suffix', () => {
  const marker = encodePageActionMarker({ action: 'refresh', token: 7, requestedAt: 1_784_100_000_000 });
  const title = `Codex${marker}`;

  assert.ok(marker.startsWith(PAGE_ACTION_SENTINEL));
  assert.deepEqual(decodePageActionMarker(title), {
    action: 'refresh',
    token: 7,
    requestedAt: 1_784_100_000_000,
  });
  assert.equal(stripPageActionMarker(title), 'Codex');
});

test('rapid refresh and Hub actions remain together until one exact acknowledgement', () => {
  const refresh = { action: 'refresh', token: 1, requestedAt: 1_784_100_000_001 };
  const openHub = { action: 'open-hub', token: 2, requestedAt: 1_784_100_000_002 };
  const afterRefresh = enqueuePageActionTitle('Codex', refresh, PAGE_ACTION_SENTINEL);
  const afterHub = enqueuePageActionTitle(afterRefresh, openHub, PAGE_ACTION_SENTINEL);

  assert.deepEqual(decodePageActionQueue(afterHub), [refresh, openHub]);
  assert.equal(stripPageActionMarker(afterHub), 'Codex');
  assert.ok(afterHub.length - 'Codex'.length < 1_024, 'the two-action marker stays bounded');
});

test('balance, request-log, and Hub actions share one bounded queue', () => {
  const actions = [
    { action: 'refresh', token: 1, requestedAt: 1_784_100_000_001 },
    { action: 'refresh-requests', token: 2, requestedAt: 1_784_100_000_002 },
    { action: 'open-hub', token: 3, requestedAt: 1_784_100_000_003 },
  ];
  const title = actions.reduce(
    (value, action) => enqueuePageActionTitle(value, action, PAGE_ACTION_SENTINEL),
    'Codex',
  );

  assert.deepEqual(decodePageActionQueue(title), actions);
  assert.ok(title.length - 'Codex'.length < 1_024);
});

test('repeated actions coalesce to the latest token without dropping the other action type', () => {
  const queued = encodePageActionQueue([
    { action: 'refresh', token: 1, requestedAt: 100 },
    { action: 'open-hub', token: 2, requestedAt: 200 },
  ]);
  const title = enqueuePageActionTitle(`Codex${queued}`, {
    action: 'refresh', token: 3, requestedAt: 300,
  }, PAGE_ACTION_SENTINEL);

  assert.deepEqual(decodePageActionQueue(title), [
    { action: 'refresh', token: 3, requestedAt: 300 },
    { action: 'open-hub', token: 2, requestedAt: 200 },
  ]);
});

test('page action decoder rejects visible, malformed, and unsupported suffixes', () => {
  assert.equal(decodePageActionMarker('Codex'), null);
  assert.equal(decodePageActionMarker(`Codex${PAGE_ACTION_SENTINEL}visible`), null);
  assert.equal(decodePageActionMarker(encodePageActionMarker({ action: 'unsupported', token: 1, requestedAt: 2 })), null);
});

test('open-hub actions use the same bounded marker channel', () => {
  const marker = encodePageActionMarker({ action: 'open-hub', token: 3, requestedAt: 1_784_100_000_123 });
  assert.ok(marker.length < 512);
  assert.deepEqual(decodePageActionMarker(`Codex${marker}`), {
    action: 'open-hub',
    token: 3,
    requestedAt: 1_784_100_000_123,
  });
});
