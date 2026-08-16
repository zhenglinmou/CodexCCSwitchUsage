import { Buffer } from 'node:buffer';

export const MAX_USAGE_RESPONSE_BYTES = 2_000_000;

export async function readResponseTextLimited(response, maximumBytes = MAX_USAGE_RESPONSE_BYTES) {
  const limit = Math.max(1, Math.trunc(Number(maximumBytes) || MAX_USAGE_RESPONSE_BYTES));
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error('额度接口响应过大');

  if (!response?.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('额度接口响应过大');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let receivedBytes = 0;
  let cancelled = false;
  const cancel = reason => {
    if (cancelled) return;
    cancelled = true;
    try { reader.cancel(reason)?.catch?.(() => {}); } catch {}
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > limit) {
        const error = new Error('额度接口响应过大');
        cancel(error);
        throw error;
      }
      chunks.push(decoder.decode(bytes, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeUsage(provider, extracted) {
  if (!extracted || typeof extracted !== 'object') throw new Error('额度脚本没有返回数据');
  if (extracted.isValid === false) throw new Error(extracted.invalidMessage || '额度数据无效');

  const extra = typeof extracted.extra === 'string' ? extracted.extra.trim() : '';
  const used = finiteOrNull(extracted.used);
  const remaining = finiteOrNull(extracted.remaining);
  const total = finiteOrNull(extracted.total);
  if (!extra && used === null && remaining === null && total === null) {
    throw new Error('额度脚本未返回可显示字段');
  }

  return {
    status: 'ok',
    providerId: provider.id,
    providerName: extracted.planName || provider.name,
    websiteUrl: provider.websiteUrl,
    extra,
    periodLabel: typeof extracted.periodLabel === 'string' ? extracted.periodLabel.trim() : '',
    hideTotal: extracted.hideTotal === true,
    refreshIntervalMinutes: Math.max(1, Number(provider.usage?.autoQueryInterval) || 5),
    used,
    remaining,
    total,
    unit: typeof extracted.unit === 'string' ? extracted.unit : '',
    updatedAt: new Date().toISOString(),
  };
}
