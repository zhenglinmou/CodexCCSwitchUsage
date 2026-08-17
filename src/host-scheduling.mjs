const DEFAULT_PROVIDER_REFRESH_MS = 300_000;
const MIN_PROVIDER_REFRESH_MINUTES = 1;
const MAX_PROVIDER_REFRESH_MINUTES = 24 * 60;

export function currentProviderRefreshIntervalMs(provider, fallbackMs = DEFAULT_PROVIDER_REFRESH_MS) {
  const configured = Number(provider?.usage?.autoQueryInterval);
  if (!Number.isFinite(configured) || configured <= 0) return fallbackMs;
  const minutes = Math.max(MIN_PROVIDER_REFRESH_MINUTES, Math.min(MAX_PROVIDER_REFRESH_MINUTES, configured));
  return Math.round(minutes * 60_000);
}

export class RecentRequestInterestTracker {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || 10 * 60_000);
    this.targets = new Map();
  }

  open(targetId) {
    const key = String(targetId || '');
    if (!key) return false;
    this.targets.set(key, this.now() + this.ttlMs);
    return true;
  }

  close(targetId) {
    return this.targets.delete(String(targetId || ''));
  }

  retain(targetIds) {
    const retained = targetIds instanceof Set ? targetIds : new Set(targetIds || []);
    for (const targetId of this.targets.keys()) {
      if (!retained.has(targetId)) this.targets.delete(targetId);
    }
    return this.active();
  }

  clear() {
    this.targets.clear();
  }

  active() {
    const now = this.now();
    for (const [targetId, expiresAt] of this.targets) {
      if (expiresAt <= now) this.targets.delete(targetId);
    }
    return this.targets.size > 0;
  }
}
