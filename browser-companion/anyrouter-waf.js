const ACW_PERMUTATION = Object.freeze([
  15, 35, 29, 24, 33, 16, 1, 38, 10, 9,
  19, 31, 40, 27, 22, 23, 25, 13, 6, 11,
  39, 18, 20, 8, 14, 21, 32, 26, 2, 30,
  7, 4, 17, 5, 3, 28, 34, 37, 12, 36,
]);
const ACW_XOR_KEY = '3000176000856006061501533003690027800375';
const ACW_CHALLENGE_PATTERN = /\bvar\s+arg1\s*=\s*(['"])([0-9a-f]{40})\1/i;
const MAX_ACW_ATTEMPTS = 3;

export function isAnyRouterAcwUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'anyrouter.top';
  } catch {
    return false;
  }
}

export function extractAnyRouterAcwChallenge(text) {
  return String(text || '').match(ACW_CHALLENGE_PATTERN)?.[2] || '';
}

export function solveAnyRouterAcwChallenge(arg1) {
  const challenge = String(arg1 || '');
  if (!/^[0-9a-f]{40}$/i.test(challenge)) {
    throw new TypeError('AnyRouter ACW challenge must contain exactly 40 hexadecimal characters');
  }

  const reordered = Array(40).fill('');
  for (let sourceIndex = 0; sourceIndex < challenge.length; sourceIndex += 1) {
    for (let destination = 0; destination < ACW_PERMUTATION.length; destination += 1) {
      if (ACW_PERMUTATION[destination] === sourceIndex + 1) {
        reordered[destination] = challenge[sourceIndex];
        break;
      }
    }
  }

  const value = reordered.join('');
  let cookie = '';
  for (let index = 0; index < value.length; index += 2) {
    const solvedByte = Number.parseInt(value.slice(index, index + 2), 16)
      ^ Number.parseInt(ACW_XOR_KEY.slice(index, index + 2), 16);
    cookie += solvedByte.toString(16).padStart(2, '0');
  }
  return cookie;
}

export async function withAnyRouterAcwRetry(fetchOnce, setCookie, options = {}) {
  if (typeof fetchOnce !== 'function' || typeof setCookie !== 'function') {
    throw new TypeError('AnyRouter ACW retry requires fetch and cookie callbacks');
  }
  const requestedAttempts = Number(options.maxAttempts);
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.min(MAX_ACW_ATTEMPTS, Math.trunc(requestedAttempts)))
    : MAX_ACW_ATTEMPTS;

  let result = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    result = await fetchOnce();
    const challenge = extractAnyRouterAcwChallenge(result?.text);
    if (!challenge || attempt + 1 >= maxAttempts) return result;
    await setCookie(solveAnyRouterAcwChallenge(challenge));
  }
  return result;
}
