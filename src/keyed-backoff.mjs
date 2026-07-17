export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

export class KeyedBackoff {
  constructor(options = {}) {
    const delays = Array.isArray(options.delays) && options.delays.length
      ? options.delays
      : DEFAULT_RETRY_DELAYS_MS;
    this.delays = delays.map(value => Math.max(1, Number(value) || 1));
    this.now = options.now || Date.now;
    this.reset();
  }

  isReady(key = '') {
    const normalizedKey = String(key);
    return this.failures === 0
      || normalizedKey !== this.key
      || this.now() >= this.retryAt;
  }

  fail(key = '') {
    const normalizedKey = String(key);
    if (normalizedKey !== this.key) {
      this.key = normalizedKey;
      this.failures = 0;
    }
    const delay = this.delays[Math.min(this.failures, this.delays.length - 1)];
    this.failures += 1;
    this.retryAt = this.now() + delay;
    return delay;
  }

  remainingMs() {
    return this.failures === 0 ? 0 : Math.max(0, this.retryAt - this.now());
  }

  reset() {
    this.key = '';
    this.failures = 0;
    this.retryAt = 0;
  }
}
