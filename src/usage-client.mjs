import { createUsageEvaluator } from './evaluator.mjs';

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

function finiteOrNull(value) {
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
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
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
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('额度接口响应过大');
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
