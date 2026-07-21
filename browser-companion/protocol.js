export const COMPANION_PROTOCOL_VERSION = 1;
export const COMPANION_CAPABILITIES = Object.freeze([
  'query-json-v1',
  'open-login-v1',
  'session-hints-v1',
]);

// One provider query owns 45 seconds. The broker stops waiting at 44 seconds,
// while the companion spends at most 40 seconds on browser work and reserves
// the final five seconds of that work for an existing-tab fallback.
export const PROVIDER_QUERY_TIMEOUT_MS = 45_000;
export const BROWSER_CALLBACK_TIMEOUT_MS = 44_000;
export const BROWSER_JOB_TIMEOUT_MS = 40_000;
export const BROWSER_TAB_FALLBACK_RESERVE_MS = 5_000;
export const BROWSER_LOGIN_JOB_TIMEOUT_MS = 20_000;

export function companionHandshake() {
  return {
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    capabilities: [...COMPANION_CAPABILITIES],
  };
}

export function companionCompatibility(payload = {}) {
  const protocolVersion = Number(payload.protocolVersion);
  const capabilities = Array.isArray(payload.capabilities)
    ? [...new Set(payload.capabilities.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  if (!Number.isInteger(protocolVersion) || protocolVersion !== COMPANION_PROTOCOL_VERSION) {
    return {
      compatible: false,
      protocolVersion,
      capabilities,
      message: `浏览器伴侣协议不兼容：宿主需要 v${COMPANION_PROTOCOL_VERSION}，伴侣报告 ${Number.isInteger(protocolVersion) ? `v${protocolVersion}` : '未知版本'}`,
    };
  }
  const missingCapabilities = COMPANION_CAPABILITIES.filter(value => !capabilities.includes(value));
  if (missingCapabilities.length) {
    return {
      compatible: false,
      protocolVersion,
      capabilities,
      message: `浏览器伴侣缺少能力：${missingCapabilities.join(', ')}`,
    };
  }
  return { compatible: true, protocolVersion, capabilities, message: '' };
}

export function assertHostJobCompatibility(job = {}) {
  if (Number(job.protocolVersion) !== COMPANION_PROTOCOL_VERSION) {
    throw new Error(`Balance Hub 任务协议不兼容：伴侣需要 v${COMPANION_PROTOCOL_VERSION}`);
  }
  return true;
}
