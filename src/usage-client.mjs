import { createUsageEvaluator } from './evaluator.mjs';
import { isTrustedHttpUrl } from './http-allowlist.mjs';
import { normalizeUsage, readResponseTextLimited } from './usage-normalization.mjs';

export { MAX_USAGE_RESPONSE_BYTES, normalizeUsage, readResponseTextLimited } from './usage-normalization.mjs';

function replacePlaceholders(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(apiKey|baseUrl|accessToken|userId)\s*\}\}/gi, (_, key) => variables[key.toLowerCase()] ?? '');
  }
  if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, variables)]));
  }
  return value;
}

export async function queryUsage(provider, options = {}) {
  if (!provider?.usage?.enabled) throw new Error('当前供应商没有启用额度查询');
  const code = String(provider.usage.code || '').trim();
  if (!code) throw new Error('当前供应商的额度脚本为空');

  const timeoutMs = Math.max(1_000, Math.min(Number(provider.usage.timeout || 10) * 1_000, 30_000));
  const evaluatorTimeoutMs = Math.min(timeoutMs, 3_000);
  const evaluator = createUsageEvaluator(code, evaluatorTimeoutMs);
  try {
    const rawRequest = await evaluator.ready;
    const request = replacePlaceholders(rawRequest, {
      apikey: provider.apiKey,
      baseurl: provider.baseUrl,
      accesstoken: String(provider.usage?.accessToken || ''),
      userid: String(provider.usage?.userId || ''),
    });
    if (!request?.url) throw new Error('额度脚本缺少请求地址');

    const url = new URL(request.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('额度接口协议不受支持');
    if (url.protocol === 'http:' && !isTrustedHttpUrl(url, provider)) {
      throw new Error('非本地额度接口必须使用 HTTPS');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchImpl = options.fetchImpl || fetch;
      const response = await fetchImpl(url, {
        method: String(request.method || 'GET').toUpperCase(),
        headers: request.headers || {},
        body: request.body == null ? undefined : (typeof request.body === 'string' ? request.body : JSON.stringify(request.body)),
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`额度接口返回 HTTP ${response.status}`);
      const text = await readResponseTextLimited(response);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('额度接口未返回 JSON');
      }
      const extracted = await evaluator.extract(payload, evaluatorTimeoutMs);
      return normalizeUsage(provider, extracted);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    evaluator.close();
  }
}
