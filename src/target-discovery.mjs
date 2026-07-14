import { isCodexTargetCandidate } from './cdp-client.mjs';

export class TargetDiscovery {
  constructor(client, onChange, { debounceMs = 75, onDisconnect } = {}) {
    this.client = client;
    this.onChange = onChange;
    this.onDisconnect = onDisconnect;
    this.debounceMs = debounceMs;
    this.started = false;
    this.trackedTargetIds = new Set();
    this.changeTimer = null;
    this.handleTargetInfo = params => {
      const info = params.targetInfo;
      if (!info?.targetId) return;
      const relevant = isCodexTargetCandidate(info);
      const tracked = this.trackedTargetIds.has(info.targetId);
      if (!relevant && !tracked) return;
      if (relevant) this.trackedTargetIds.add(info.targetId);
      else this.trackedTargetIds.delete(info.targetId);
      this.scheduleChange();
    };
    this.handleTargetDestroyed = params => {
      if (!this.trackedTargetIds.delete(params.targetId)) return;
      this.scheduleChange();
    };
    this.handleDisconnect = error => this.onDisconnect?.(error);
  }

  async start() {
    if (this.started) return;
    this.client.on('Target.targetCreated', this.handleTargetInfo);
    this.client.on('Target.targetInfoChanged', this.handleTargetInfo);
    this.client.on('Target.targetDestroyed', this.handleTargetDestroyed);
    this.client.onClose(this.handleDisconnect);
    await this.client.call('Target.setDiscoverTargets', { discover: true });
    this.started = true;
  }

  scheduleChange() {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.onChange?.();
    }, this.debounceMs);
  }

  close() {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.client.off('Target.targetCreated', this.handleTargetInfo);
    this.client.off('Target.targetInfoChanged', this.handleTargetInfo);
    this.client.off('Target.targetDestroyed', this.handleTargetDestroyed);
    this.client.offClose(this.handleDisconnect);
    this.trackedTargetIds.clear();
    this.client.close();
    this.started = false;
  }
}
