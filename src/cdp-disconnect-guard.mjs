export class CdpDisconnectGuard {
  constructor({
    graceMs,
    verifyConnection,
    onExpired,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.graceMs = graceMs;
    this.verifyConnection = verifyConnection;
    this.onExpired = onExpired;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.closed = false;
  }

  notifyDisconnected() {
    if (this.closed || this.timer) return false;
    const timer = this.setTimer(async () => {
      if (this.closed || this.timer !== timer) return;
      let connected = false;
      try { connected = await this.verifyConnection(); } catch {}
      if (this.closed || this.timer !== timer) return;
      this.timer = null;
      if (!connected) this.onExpired?.();
    }, this.graceMs);
    this.timer = timer;
    return true;
  }

  notifyConnected() {
    if (!this.timer) return false;
    this.clearTimer(this.timer);
    this.timer = null;
    return true;
  }

  close() {
    this.closed = true;
    this.notifyConnected();
  }
}
