export const PAGE_ACTION_SENTINEL = '\u2063\u2063';
const ZERO = '\u200b';
const ONE = '\u200c';
const ACTIONS = new Set(['refresh', 'refresh-requests', 'requests-open', 'requests-close', 'open-hub']);
const ACTION_SLOT_COUNT = 3;
const QUEUE_PREFIX = 'q1;';
const MAX_MARKER_LENGTH = 1_024;

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

function actionSlot(action) {
  if (['refresh-requests', 'requests-open', 'requests-close'].includes(action)) return 'requests';
  return action;
}

export function encodePageActionMarker(value) {
  const action = normalizeAction(value);
  if (!action) return '';
  return `${PAGE_ACTION_SENTINEL}${bytesToInvisible(`${action.action}|${action.token}|${action.requestedAt}`)}`;
}

export function encodePageActionQueue(values) {
  const actions = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const action = normalizeAction(value);
    if (!action) return '';
    const existingIndex = actions.findIndex(item => actionSlot(item.action) === actionSlot(action.action));
    if (existingIndex >= 0) actions[existingIndex] = action;
    else actions.push(action);
  }
  if (!actions.length) return '';
  const payload = `${QUEUE_PREFIX}${actions.map(action => `${action.action}|${action.token}|${action.requestedAt}`).join(';')}`;
  const marker = bytesToInvisible(payload);
  return marker.length <= MAX_MARKER_LENGTH ? `${PAGE_ACTION_SENTINEL}${marker}` : '';
}

export function decodePageActionQueue(title) {
  const value = String(title || '');
  const markerIndex = value.lastIndexOf(PAGE_ACTION_SENTINEL);
  if (markerIndex < 0) return [];
  const marker = value.slice(markerIndex + PAGE_ACTION_SENTINEL.length);
  if (!marker || marker.length > MAX_MARKER_LENGTH) return [];
  const decoded = invisibleToBytes(marker);
  if (!decoded) return [];
  const entries = decoded.startsWith(QUEUE_PREFIX) ? decoded.slice(QUEUE_PREFIX.length).split(';') : [decoded];
  if (!entries.length || entries.length > ACTION_SLOT_COUNT) return [];
  const actions = [];
  for (const entry of entries) {
    const [action, token, requestedAt, extra] = entry.split('|');
    const normalized = extra === undefined
      ? normalizeAction({ action, token: Number(token), requestedAt: Number(requestedAt) })
      : null;
    if (!normalized || actions.some(item => actionSlot(item.action) === actionSlot(normalized.action))) return [];
    actions.push(normalized);
  }
  return actions;
}

export function decodePageActionMarker(title) {
  return decodePageActionQueue(title)[0] || null;
}

export function stripPageActionMarker(title) {
  const value = String(title || '');
  const markerIndex = value.lastIndexOf(PAGE_ACTION_SENTINEL);
  return markerIndex < 0 ? value : value.slice(0, markerIndex);
}

// This helper is serialized into the injected page. Keep it self-contained and
// limited to ASCII so it works without Node.js Buffer in the renderer.
export function enqueuePageActionTitle(title, value, sentinel) {
  const currentTitle = String(title || '');
  const markerSentinel = String(sentinel || '\u2063\u2063');
  const normalize = candidate => {
    const action = String(candidate?.action || '');
    const token = Number(candidate?.token);
    const requestedAt = Number(candidate?.requestedAt);
    if (!['refresh', 'refresh-requests', 'requests-open', 'requests-close', 'open-hub'].includes(action) || !Number.isSafeInteger(token) || token < 0 || !Number.isFinite(requestedAt) || requestedAt <= 0) return null;
    return { action, token, requestedAt };
  };
  const slot = action => ['refresh-requests', 'requests-open', 'requests-close'].includes(action) ? 'requests' : action;
  const next = normalize(value);
  if (!next) return currentTitle;

  const markerIndex = currentTitle.lastIndexOf(markerSentinel);
  const baseTitle = markerIndex < 0 ? currentTitle : currentTitle.slice(0, markerIndex);
  const actions = [];
  if (markerIndex >= 0) {
    const invisible = currentTitle.slice(markerIndex + markerSentinel.length);
    if (invisible && invisible.length <= 1_024 && invisible.length % 8 === 0) {
      let decoded = '';
      let valid = true;
      for (let index = 0; index < invisible.length; index += 8) {
        const chunk = invisible.slice(index, index + 8);
        if ([...chunk].some(character => character !== '\u200b' && character !== '\u200c')) {
          valid = false;
          break;
        }
        const byte = Number.parseInt(chunk.replaceAll('\u200b', '0').replaceAll('\u200c', '1'), 2);
        if (!Number.isInteger(byte) || byte > 127) {
          valid = false;
          break;
        }
        decoded += String.fromCharCode(byte);
      }
      if (valid) {
        const entries = decoded.startsWith('q1;') ? decoded.slice(3).split(';') : [decoded];
        for (const entry of entries.slice(0, 3)) {
          const [action, token, requestedAt, extra] = entry.split('|');
          const existing = extra === undefined ? normalize({ action, token: Number(token), requestedAt: Number(requestedAt) }) : null;
          if (existing && !actions.some(item => slot(item.action) === slot(existing.action))) actions.push(existing);
        }
      }
    }
  }

  const existingIndex = actions.findIndex(item => slot(item.action) === slot(next.action));
  if (existingIndex >= 0) actions[existingIndex] = next;
  else actions.push(next);
  const payload = `q1;${actions.map(action => `${action.action}|${action.token}|${action.requestedAt}`).join(';')}`;
  let marker = '';
  for (let index = 0; index < payload.length; index += 1) {
    marker += payload.charCodeAt(index).toString(2).padStart(8, '0').replaceAll('0', '\u200b').replaceAll('1', '\u200c');
  }
  return `${baseTitle}${markerSentinel}${marker}`;
}
