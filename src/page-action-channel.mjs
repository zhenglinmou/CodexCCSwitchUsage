export const PAGE_ACTION_SENTINEL = '\u2063\u2063';
const ZERO = '\u200b';
const ONE = '\u200c';
const ACTIONS = new Set(['refresh', 'open-hub']);
const MAX_MARKER_LENGTH = 512;

function bytesToInvisible(value) {
  let result = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    result += byte.toString(2).padStart(8, '0').replaceAll('0', ZERO).replaceAll('1', ONE);
  }
  return result;
}

function invisibleToBytes(value) {
  if (!value || value.length % 8 !== 0 || [...value].some(character => character !== ZERO && character !== ONE)) return null;
  const bytes = [];
  for (let index = 0; index < value.length; index += 8) {
    const binary = value.slice(index, index + 8).replaceAll(ZERO, '0').replaceAll(ONE, '1');
    bytes.push(Number.parseInt(binary, 2));
  }
  return Buffer.from(bytes).toString('utf8');
}

function normalizeAction(value) {
  const action = String(value?.action || '');
  const token = Number(value?.token);
  const requestedAt = Number(value?.requestedAt);
  if (!ACTIONS.has(action) || !Number.isSafeInteger(token) || token < 0 || !Number.isFinite(requestedAt) || requestedAt <= 0) return null;
  return { action, token, requestedAt };
}

export function encodePageActionMarker(value) {
  const action = normalizeAction(value);
  if (!action) return '';
  return `${PAGE_ACTION_SENTINEL}${bytesToInvisible(`${action.action}|${action.token}|${action.requestedAt}`)}`;
}

export function decodePageActionMarker(title) {
  const value = String(title || '');
  const markerIndex = value.lastIndexOf(PAGE_ACTION_SENTINEL);
  if (markerIndex < 0) return null;
  const marker = value.slice(markerIndex + PAGE_ACTION_SENTINEL.length);
  if (!marker || marker.length > MAX_MARKER_LENGTH) return null;
  const decoded = invisibleToBytes(marker);
  if (!decoded) return null;
  const [action, token, requestedAt, extra] = decoded.split('|');
  if (extra !== undefined) return null;
  return normalizeAction({ action, token: Number(token), requestedAt: Number(requestedAt) });
}

export function stripPageActionMarker(title) {
  const value = String(title || '');
  const markerIndex = value.lastIndexOf(PAGE_ACTION_SENTINEL);
  return markerIndex < 0 ? value : value.slice(0, markerIndex);
}
