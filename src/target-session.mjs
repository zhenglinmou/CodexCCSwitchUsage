export function settleTargetOperations(targets, operation) {
  return Promise.allSettled(targets.map(operation));
}

export function disposeTargetInjector(client, globalName) {
  const globalReference = `window[${JSON.stringify(globalName)}]`;
  return client.evaluate(`(() => {
    const state = ${globalReference};
    if (!state) return false;
    state.eventController?.abort();
    state.observer?.disconnect();
    state.themeObserver?.disconnect();
    state.resizeObserver?.disconnect();
    for (const mirror of state.mirrors || []) mirror.root?.remove();
    for (const timer of state.layoutTimers || []) clearTimeout(timer);
    if (state.tooltipTimer) clearTimeout(state.tooltipTimer);
    if (state.mountTimer) clearTimeout(state.mountTimer);
    if (state.resizeSettleTimer) clearTimeout(state.resizeSettleTimer);
    if (state.rootResizeSettleTimer) clearTimeout(state.rootResizeSettleTimer);
    if (state.layoutFrame) cancelAnimationFrame(state.layoutFrame);
    if (state.composerSyncFrame) cancelAnimationFrame(state.composerSyncFrame);
    state.root?.remove();
    state.popoverRoot?.remove();
    delete window[${JSON.stringify(globalName)}];
    return true;
  })()`);
}

export class TargetSession {
  constructor(client, {
    globalName,
    injectorVersion,
    injectorScript,
    refreshBindingName = '',
    onRefresh,
    onContextReset,
  }) {
    this.client = client;
    this.globalName = globalName;
    this.injectorVersion = injectorVersion;
    this.injectorScript = injectorScript;
    this.payloadSignature = null;
    this.refreshBindingName = refreshBindingName;
    this.onRefresh = onRefresh;
    this.onContextReset = onContextReset;
    this.initialized = false;
    this.handleBindingCalled = params => {
      if (params.name !== this.refreshBindingName) return;
      let payload = {};
      try { payload = JSON.parse(params.payload || '{}'); } catch {}
      this.onRefresh?.(payload);
    };
    this.handleContextsCleared = () => {
      this.payloadSignature = null;
      this.onContextReset?.();
    };
  }

  get closed() {
    return this.client.closed;
  }

  get globalReference() {
    return `window[${JSON.stringify(this.globalName)}]`;
  }

  async initialize() {
    if (this.initialized) return;
    this.client.on('Runtime.bindingCalled', this.handleBindingCalled);
    this.client.on('Runtime.executionContextsCleared', this.handleContextsCleared);
    await this.client.call('Runtime.enable', {});
    if (this.refreshBindingName) {
      await this.client.call('Runtime.addBinding', { name: this.refreshBindingName });
    }
    this.initialized = true;
  }

  async ensureInjector() {
    const inspection = await this.client.evaluate(
      `({ version: ${this.globalReference}?.version || 0, mounted: Boolean(${this.globalReference}?.root?.isConnected && ${this.globalReference}?.footer?.isConnected) })`,
    );
    const installedVersion = Number(inspection?.version || 0);
    if (installedVersion === this.injectorVersion) {
      if (!inspection?.mounted) await this.client.evaluate(`${this.globalReference}?.mount?.() === true`);
      return false;
    }
    await this.client.evaluate(this.injectorScript);
    this.payloadSignature = null;
    return true;
  }

  async updatePayload(payload) {
    const signature = JSON.stringify(payload) ?? 'null';
    if (signature === this.payloadSignature) return false;
    const updated = await this.client.evaluate(`${this.globalReference}?.update(${signature}) === true`);
    if (updated !== true) throw new Error('Codex 用量脚本尚未注入');
    this.payloadSignature = signature;
    return true;
  }

  async getRefreshRequest() {
    return this.client.evaluate(
      `${this.globalReference}?.getRefreshRequest?.() || { token: ${this.globalReference}?.getRefreshToken?.() || 0, requestedAt: 0 }`,
    );
  }

  close() {
    this.client.off('Runtime.bindingCalled', this.handleBindingCalled);
    this.client.off('Runtime.executionContextsCleared', this.handleContextsCleared);
    this.client.close();
  }
}
