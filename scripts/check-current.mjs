import { ProviderRepository } from '../src/provider-repository.mjs';
import { queryUsage } from '../src/usage-client.mjs';

const repository = new ProviderRepository();
const requestedName = process.argv[2];
const provider = requestedName ? repository.getByName(requestedName) : repository.getCurrent();
if (!provider) throw new Error('没有找到当前 Codex 供应商');
const usage = await queryUsage(provider);
console.log(JSON.stringify({
  provider: provider.name,
  status: usage.status,
  extra: usage.extra,
  used: usage.used,
  remaining: usage.remaining,
  total: usage.total,
  unit: usage.unit,
}));
