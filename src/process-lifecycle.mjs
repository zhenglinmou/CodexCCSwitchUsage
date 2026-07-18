export function isProcessAlive(processId, signalProcess = process.kill) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    signalProcess(processId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class ProcessExitMonitor {
  constructor({
    processId,
    onExit,
    intervalMs = 250,
    isAlive = isProcessAlive,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    if (!Number.isInteger(processId) || processId <= 0) throw new TypeError('processId must be a positive integer');
    if (typeof onExit !== 'function') throw new TypeError('onExit must be a function');
    this.processId = processId;
    this.onExit = onExit;
    this.intervalMs = intervalMs;
    this.isAlive = isAlive;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.closed = false;
  }

  start() {
    if (this.closed || this.timer) return false;
    this.timer = this.setIntervalFn(() => this.check(), this.intervalMs);
    this.check();
    return true;
  }

  check() {
    if (this.closed) return false;
    let alive = true;
    try { alive = this.isAlive(this.processId); } catch {}
    if (alive) return false;
    const onExit = this.onExit;
    this.close();
    onExit();
    return true;
  }

  close() {
    if (this.closed) return false;
    this.closed = true;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    return true;
  }
}
