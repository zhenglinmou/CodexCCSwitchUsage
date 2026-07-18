import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePageActionMarker,
  encodePageActionMarker,
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
