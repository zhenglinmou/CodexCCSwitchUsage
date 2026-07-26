import { enqueuePageActionTitle, PAGE_ACTION_SENTINEL } from './page-action-channel.mjs';

export function findUsageTooltipTarget(target) {
  if (!target?.closest || target.closest('.refresh,.hub-trigger,.hub-open')) return null;
  return target.closest('.metric,.meter,.message');
}

export function isUsageTooltipBoundaryCrossing(target, relatedTarget, findTarget = findUsageTooltipTarget) {
  return Boolean(findTarget(target) && !findTarget(relatedTarget));
}

export function getUsageFreshness(payload, now = Date.now()) {
  if (payload?.status !== 'ok') return 'unknown';
  const updatedAt = Date.parse(payload.updatedAt || '');
  if (!Number.isFinite(updatedAt)) return payload.queryError ? 'degraded' : 'unknown';
  const intervalMinutes = Math.max(1, Number(payload.refreshIntervalMinutes) || 5);
  const age = Math.max(0, now - updatedAt);
  if (age >= Math.max(30, intervalMinutes * 6) * 60_000) return 'expired';
  if (payload.queryError) return 'degraded';
  if (age >= Math.max(10, intervalMinutes * 2) * 60_000) return 'stale';
  return 'fresh';
}

export function formatUsageAge(updatedAt, now = Date.now()) {
  const timestamp = Date.parse(updatedAt || '');
  if (!Number.isFinite(timestamp)) return '未知';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function formatRequestTime(value) {
  if (value == null || value === '') return '--';
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '--';
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function selectResponsiveUsageMode(measurements, previousMode = '', upgradeMargin = 12) {
  const modes = ['full', 'compact', 'no-extra', 'no-used', 'no-meter', 'no-dot', 'icon'];
  const selected = modes.find(mode => measurements?.[mode]?.fits) || 'icon';
  const previousIndex = modes.indexOf(previousMode);
  const selectedIndex = modes.indexOf(selected);
  if (previousIndex > selectedIndex && measurements?.[previousMode]?.fits && measurements?.[selected]?.spare < upgradeMargin) {
    return previousMode;
  }
  return selected;
}

export function calculateResponsiveMeasurements(modeMetrics, {
  rootLeft = 0,
  rootWidth = 0,
  usageLeft = rootLeft,
  usageWidth = rootWidth,
  clientWidth = rootWidth,
  nativeLeft = null,
} = {}) {
  const usageCenter = usageLeft + usageWidth / 2;
  return Object.fromEntries(Object.entries(modeMetrics || {}).map(([mode, metric]) => {
    const contentSpare = clientWidth - Number(metric.requiredWidth || 0);
    const refreshRightOffset = Number(metric.refreshRightOffset);
    const controlsSpare = nativeLeft == null || !Number.isFinite(refreshRightOffset)
      ? Number.POSITIVE_INFINITY
      : nativeLeft - (usageCenter + refreshRightOffset);
    return [mode, {
      fits: contentSpare >= -0.5 && controlsSpare >= -0.5,
      spare: contentSpare,
    }];
  }));
}

export function stabilizeResponsiveUsageMode(
  selectedMode,
  previousMode,
  currentConstraintWidth,
  previousConstraintWidth,
  previousDirection = '',
) {
  const modes = ['full', 'compact', 'no-extra', 'no-used', 'no-meter', 'no-dot', 'icon'];
  let direction = previousDirection;
  if (Number.isFinite(currentConstraintWidth) && Number.isFinite(previousConstraintWidth)) {
    if (currentConstraintWidth < previousConstraintWidth - 0.5) direction = 'shrinking';
    else if (currentConstraintWidth > previousConstraintWidth + 0.5) direction = 'expanding';
  }
  const selectedIndex = modes.indexOf(selectedMode);
  const previousIndex = modes.indexOf(previousMode);
  if (direction === 'shrinking' && selectedIndex >= 0 && previousIndex >= 0 && selectedIndex < previousIndex) {
    return { mode: previousMode, direction };
  }
  if (direction === 'expanding' && selectedIndex >= 0 && previousIndex >= 0 && selectedIndex > previousIndex) {
    return { mode: previousMode, direction };
  }
  return { mode: selectedMode, direction };
}

export function findMutationObserverTarget(footer, documentNode = globalThis.document) {
  const mainSelector = 'main,[role="main"],[data-codex-main]';
  const composerSelector = '.composer-surface-chrome,[data-composer-surface],[class*="composer"]';
  const appRoot = footer?.closest?.('#root');
  if (appRoot) return appRoot;
  const main = footer?.closest?.(mainSelector);
  if (main?.parentElement) return main.parentElement;
  const composer = footer?.closest?.(composerSelector);
  if (composer?.parentElement) return composer.parentElement;
  if (footer?.parentElement) return footer.parentElement;
  const fallbackMain = documentNode?.querySelector?.(mainSelector);
  return fallbackMain?.parentElement || fallbackMain || documentNode?.body || null;
}

export function classifyComposerMutations(records, footer, root) {
  const selector = '.ProseMirror[contenteditable="true"],[contenteditable="true"].ProseMirror,[contenteditable="true"][role="textbox"],[contenteditable="true"][data-lexical-editor="true"],.composer-surface-chrome,[data-composer-surface],[data-composer-footer],[class*="_footer_"]';
  const stableMount = Boolean(footer?.isConnected && root?.isConnected);
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    for (let listIndex = 0; listIndex < 2; listIndex += 1) {
      const nodes = listIndex === 0 ? record.addedNodes : record.removedNodes;
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        if (node?.nodeType !== 1) continue;
        if (
          (listIndex === 1 && !stableMount && (
            node === footer
            || node === root
            || node.contains?.(footer)
            || node.contains?.(root)
          ))
          || node.matches?.(selector)
          || (node.childElementCount !== 0 && node.querySelector?.(selector))
        ) return 'mount';
      }
    }
  }
  return 'ignore';
}

export function mutationNeedsComposerSync(records, footer, root) {
  return classifyComposerMutations(records, footer, root) === 'mount';
}

export function createInjectorEventController(existing, AbortControllerType = globalThis.AbortController) {
  existing?.eventController?.abort();
  return new AbortControllerType();
}

export function updateElementAttribute(element, name, value) {
  if (!element) return false;
  const normalized = value == null ? null : String(value);
  if (element.getAttribute(name) === normalized) return false;
  if (normalized == null) element.removeAttribute(name);
  else element.setAttribute(name, normalized);
  return true;
}

export function isComposerFooterCandidate(element, editor, rect, editorRect) {
  const children = Array.from(element?.children || []);
  if (!editor || children.length < 3 || !rect || !editorRect) return false;
  if (rect.width <= 0 || rect.height < 20) return false;

  const editorPart = children.find(child => child === editor || child.contains?.(editor));
  const embeddedEditorLayout = Boolean(editorPart && children.filter(child => (
    child !== editorPart
    && child.querySelector?.('button,[role="button"],[aria-label]')
  )).length >= 2);

  if (embeddedEditorLayout) return true;
  return rect.height <= 52 && rect.top >= editorRect.bottom - 24;
}

export function isNativeFlowCacheValid(cache, root, right, getStyle = globalThis.getComputedStyle) {
  const flowSignature = lane => {
    const signature = element => {
      if (!element) return '';
      const style = getStyle(element);
      return [style.display || '', style.flexGrow || '', style.flexShrink || ''].join(':');
    };
    return `${signature(lane)}|${signature(lane?.parentElement)}`;
  };
  return Boolean(
    cache
    && cache.right === right
    && cache.lane?.isConnected
    && (cache.before == null || cache.before.isConnected)
    && root?.parentElement === cache.lane
    && root?.nextElementSibling === cache.before
    && cache.signature === flowSignature(cache.lane)
  );
}

export function resolveNativeFlowPlacement(right, root, toolbar, getStyle = globalThis.getComputedStyle) {
  const toolbarParent = toolbar?.parentElement;
  if (toolbarParent && right?.contains?.(toolbarParent) && getStyle(toolbarParent).display === 'flex') {
    const outerToolbar = toolbarParent.parentElement;
    const toolbarParentStyle = getStyle(toolbarParent);
    const outerToolbarStyle = outerToolbar ? getStyle(outerToolbar) : null;
    if (
      Number.parseFloat(toolbarParentStyle.flexGrow) <= 0
      && outerToolbar
      && outerToolbar !== right
      && right.contains?.(outerToolbar)
      && outerToolbarStyle?.display === 'flex'
      && Number.parseFloat(outerToolbarStyle.flexShrink) > 0
    ) {
      return { lane: outerToolbar, before: toolbarParent };
    }
    return { lane: toolbarParent, before: toolbar };
  }

  const findFlexContainer = container => {
    for (const element of Array.from(container?.children || [])) {
      if (element === root) continue;
      const display = getStyle(element).display;
      if (display === 'flex') return element;
      if (display === 'contents') {
        const nested = findFlexContainer(element);
        if (nested) return nested;
      }
    }
    return null;
  };
  const outerToolbar = findFlexContainer(right) || right;
  const flexibleLane = Array.from(outerToolbar?.children || []).find(element => (
    element !== root
    && getStyle(element).display === 'flex'
    && Number.parseFloat(getStyle(element).flexGrow) > 0
  ));
  const lane = flexibleLane || (getStyle(outerToolbar).display === 'flex' ? outerToolbar : right);
  const candidateBefore = lane?.firstElementChild || null;
  return { lane, before: candidateBefore === root ? root.nextElementSibling : candidateBefore };
}

export { PAGE_ACTION_SENTINEL };
export const INJECTOR_VERSION = 82;

function installCodexUsageExtension(findUsageTooltipTarget, isUsageTooltipBoundaryCrossing, getUsageFreshness, formatUsageAge, formatRequestTime, selectResponsiveUsageMode, calculateResponsiveMeasurements, stabilizeResponsiveUsageMode, findMutationObserverTarget, classifyComposerMutations, createInjectorEventController, updateElementAttribute, isComposerFooterCandidate, isNativeFlowCacheValid, resolveNativeFlowPlacement, enqueuePageActionTitle, pageActionSentinel, version) {
  const VERSION = version;
  const GLOBAL = '__CODEX_CCSWITCH_USAGE__';
  const ROOT_ID = 'codex-ccswitch-usage-root';
  const POPOVER_ID = 'codex-ccswitch-usage-popover';
  const REFRESH_LOADING_TIMEOUT_MS = 95_000;
  const existing = window[GLOBAL];
  if (existing?.version === VERSION) {
    return existing.mount() === true;
  }
  const eventController = createInjectorEventController(existing);
  if (existing) {
    existing.observer?.disconnect();
    existing.themeObserver?.disconnect();
    existing.resizeObserver?.disconnect();
    for (const mirror of existing.mirrors || []) {
      mirror.root?.remove();
    }
    for (const timer of existing.layoutTimers || []) clearTimeout(timer);
    if (existing.tooltipTimer) clearTimeout(existing.tooltipTimer);
    if (existing.refreshLoadingTimer) clearTimeout(existing.refreshLoadingTimer);
    if (existing.requestLoadingTimer) clearTimeout(existing.requestLoadingTimer);
    if (existing.mountTimer) clearTimeout(existing.mountTimer);
    if (existing.resizeSettleTimer) clearTimeout(existing.resizeSettleTimer);
    if (existing.rootResizeSettleTimer) clearTimeout(existing.rootResizeSettleTimer);
    if (existing.layoutFrame) cancelAnimationFrame(existing.layoutFrame);
    if (existing.composerSyncFrame) cancelAnimationFrame(existing.composerSyncFrame);
    existing.root?.remove();
    existing.popoverRoot?.remove();
    existing.root = null;
    existing.shadow = null;
    existing.footer = null;
  }

  const state = {
    version: VERSION,
    payload: null,
    root: null,
    shadow: null,
    footer: null,
    refreshToken: 0,
    refreshRequestedAt: 0,
    actionToken: 0,
    observer: null,
    observerTarget: null,
    themeObserver: null,
    resizeObserver: null,
    resizeObservedElements: [],
    layoutFrame: 0,
    composerSyncFrame: 0,
    popoverOpen: false,
    popoverMode: '',
    popoverTrigger: null,
    loading: false,
    refreshLoadingTimer: 0,
    requestRefreshToken: 0,
    requestLoading: false,
    requestLoadingTimer: 0,
    popoverRoot: null,
    popoverShadow: null,
    layoutTimers: [],
    mirrors: [],
    nextRootId: 1,
    popoverAnchor: null,
    tooltipAnchor: null,
    tooltipTimer: 0,
    popoverPayload: null,
    recentRequestsPayload: null,
    recentRequestsAgeMinute: -1,
    eventController,
    usageStyleSheet: null,
    __codexUsageView: null,
    resizeSettleTimer: 0,
    rootResizeSizes: new WeakMap(),
  };

  const numberFormatter = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
  const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const responsiveModes = ['full', 'compact', 'no-extra', 'no-used', 'no-meter', 'no-dot', 'icon'];

  const formatNumber = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return numberFormatter.format(number);
  };

  const balancePayloadSignature = payload => JSON.stringify([
    payload?.status,
    payload?.providerId,
    payload?.providerDisplayName,
    payload?.providerName,
    payload?.accountBrowser,
    payload?.websiteUrl,
    payload?.message,
    payload?.extra,
    payload?.periodLabel,
    payload?.hideTotal,
    payload?.refreshIntervalMinutes,
    payload?.used,
    payload?.remaining,
    payload?.total,
    payload?.unit,
    payload?.updatedAt,
    payload?.queryError,
  ]);

  function footerParts(footer) {
    const children = footer?.children;
    if (!children || children.length < 3) return null;
    return { left: children[0], middle: children[1], right: children[children.length - 1] };
  }

  function findComposerFooter(surface, editor) {
    const editorRect = editor.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const candidates = [...new Set([
      ...surface.querySelectorAll('[data-composer-footer], [class*="_footer_"], [class*="grid-cols-"]'),
      ...surface.querySelectorAll('div'),
    ])];
    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const parts = footerParts(element);
      if (!parts) continue;
      const rect = element.getBoundingClientRect();
      if (!isComposerFooterCandidate(element, editor, rect, editorRect)) continue;
      const className = String(element.className || '');
      let score = 0;
      if (element.hasAttribute('data-composer-footer')) score += 8;
      if (className.includes('_footer_')) score += 6;
      if (className.includes('grid-cols-')) score += 4;
      if (element.children.length === 3) score += 2;
      if (rect.bottom >= surfaceRect.bottom - 48) score += 2;
      if (element.querySelector('button,[role="button"],[aria-label]')) score += 2;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return bestScore >= 2 ? best : null;
  }

  function findFooters() {
    const editors = [...document.querySelectorAll([
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"].ProseMirror',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
    ].join(','))];
    const footers = [];
    for (const editor of editors) {
      const editorRect = editor.getBoundingClientRect();
      if (!editor.isConnected || editorRect.width <= 0 || editorRect.height <= 0) continue;
      const surface = editor.closest('.composer-surface-chrome, [data-composer-surface], [class*="composer"]');
      if (!surface) continue;
      const footer = findComposerFooter(surface, editor);
      if (footer && !footers.includes(footer)) footers.push(footer);
    }
    return footers;
  }

  const usageStyles = `
    :host{font:inherit;color:inherit;min-width:0;transition:opacity .15s cubic-bezier(.4,0,.2,1);}
    *{box-sizing:border-box}
    .usage{height:28px;display:flex;align-items:center;justify-content:center;gap:var(--spacing-token-button-composer-gap,4px);min-width:0;overflow:hidden;white-space:nowrap;color:var(--color-token-text-tertiary,var(--color-text-foreground-tertiary,currentColor));font-family:inherit;font-size:var(--text-sm,13px);font-weight:inherit;line-height:18px;letter-spacing:normal}
    .status-dot{width:6px;height:6px;border-radius:9999px;background:var(--color-text-success,#40c977);flex:0 0 auto}
    .usage[data-status="error"] .status-dot{background:var(--color-text-warning,#ff8549)}
    .usage[data-query-error="true"] .status-dot{background:var(--color-text-warning,#ff8549)}
    .usage[data-freshness="degraded"] .status-dot{background:var(--color-text-warning,#ff8549)}
    .usage[data-freshness="stale"] .status-dot{background:#e7ad23}
    .usage[data-freshness="expired"] .status-dot{background:currentColor;opacity:.55}
    .usage[data-status="unsupported"] .status-dot{background:var(--color-token-text-tertiary,currentColor)}
    .metric{flex:0 0 auto;color:inherit;font:inherit;letter-spacing:inherit}
    .remaining-value{color:#c77dff;font-weight:600}
    .metric strong{font:inherit;color:inherit}
    .meter{width:44px;height:4px;border-radius:999px;background:color-mix(in srgb,currentColor 13%,transparent);overflow:hidden;flex:0 0 auto}
    .meter>i{height:100%;display:block;background:#168bd2;border-radius:inherit}
    .meter[data-balance-level="warning"]>i{background:var(--color-text-warning,#ff9f43)}
    .meter[data-balance-level="critical"]>i{background:var(--color-text-danger,#ef4444)}
    .usage[data-balance-level="warning"] .remaining-value{color:var(--color-text-warning,#ff9f43)}
    .usage[data-balance-level="critical"] .remaining-value{color:var(--color-text-danger,#ef4444)}
    .toolbar-action{appearance:none;border:0;background:transparent;color:inherit;width:28px;height:28px;padding:6px;display:grid;place-items:center;border-radius:9999px;cursor:pointer;flex:0 0 auto;font:inherit;line-height:18px}
    .toolbar-action:hover{background:var(--color-background-button-tertiary-hover,rgba(127,127,127,.08))}
    .toolbar-action svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .refresh[data-loading="true"] svg{animation:codex-usage-spin .8s linear infinite}
    .message{overflow:hidden;text-overflow:ellipsis;color:inherit;font:inherit}
    @keyframes codex-usage-spin{to{transform:rotate(-360deg)}}
    @media (prefers-reduced-motion:reduce){:host{transition:none}.refresh svg{animation:none!important}}
    :host([data-mode="compact"]) .extra-secondary{display:none}
    :host([data-mode="no-extra"]) .extra{display:none}
    :host([data-mode="no-used"]) .extra,:host([data-mode="no-used"]) .used{display:none}
    :host([data-mode="no-meter"]) .extra,:host([data-mode="no-meter"]) .used,:host([data-mode="no-meter"]) .meter{display:none}
    :host([data-mode="no-dot"]) .extra,:host([data-mode="no-dot"]) .used,:host([data-mode="no-dot"]) .meter,:host([data-mode="no-dot"]) .status-dot{display:none}
    :host([data-mode="icon"]) .status-dot,:host([data-mode="icon"]) .metric,:host([data-mode="icon"]) .meter,:host([data-mode="icon"]) .message,:host([data-mode="icon"]) .hub-trigger{display:none}
    :host([data-mode="icon"]) .usage{justify-content:center;gap:0}
    :host([data-mode="hidden"]){opacity:0!important;visibility:hidden!important;pointer-events:none!important}
  `;

  function installUsageStyles(shadow) {
    if (!state.usageStyleSheet && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in shadow) {
      try {
        state.usageStyleSheet = new CSSStyleSheet();
        state.usageStyleSheet.replaceSync(usageStyles);
      } catch {
        state.usageStyleSheet = null;
      }
    }
    if (state.usageStyleSheet && 'adoptedStyleSheets' in shadow) {
      try {
        shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, state.usageStyleSheet];
        return;
      } catch {}
    }
    const style = document.createElement('style');
    style.textContent = usageStyles;
    shadow.appendChild(style);
  }

  function createRoot() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.codexUsageRoot = 'primary';
    root.style.cssText = 'display:block;position:absolute;left:0;top:0;min-width:0;height:28px;overflow:hidden;pointer-events:auto;z-index:2;';
    const shadow = root.attachShadow({ mode: 'open' });
    installUsageStyles(shadow);
    const content = document.createElement('div');
    content.id = 'content';
    shadow.appendChild(content);
    state.root = root;
    state.shadow = shadow;
    return root;
  }

  function createMirror(footer) {
    const root = document.createElement('div');
    root.id = `${ROOT_ID}-${state.nextRootId++}`;
    root.dataset.codexUsageRoot = 'mirror';
    root.style.cssText = 'display:block;position:absolute;left:0;top:0;min-width:0;height:28px;overflow:hidden;pointer-events:auto;z-index:2;';
    const shadow = root.attachShadow({ mode: 'open' });
    installUsageStyles(shadow);
    const content = document.createElement('div');
    content.id = 'content';
    shadow.appendChild(content);
    const mirror = { footer, root, shadow };
    const parts = footerParts(footer);
    placeInNativeFlow(root, parts.right);
    state.mirrors.push(mirror);
    return mirror;
  }

  function removeMirror(mirror) {
    mirror.root?.remove();
    state.mirrors = state.mirrors.filter(item => item !== mirror);
    if (state.popoverAnchor === mirror) state.popoverAnchor = null;
    if (state.tooltipAnchor === mirror) hideUsageTooltip();
  }

  function ensurePopoverPortal() {
    let host = document.getElementById(POPOVER_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = POPOVER_ID;
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483000;';
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        *{box-sizing:border-box}
        .popover{position:fixed;z-index:2147483000;width:min(236px,calc(100vw - 16px));max-height:calc(100vh - 16px);padding:12px;border:1px solid var(--color-token-border,var(--color-token-button-border,rgba(127,127,127,.16)));border-radius:14px;background:var(--color-token-dropdown-background,rgb(38,38,38));box-shadow:0 12px 32px rgba(0,0,0,.32);color:var(--color-token-text-primary,currentColor);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:var(--text-sm,13px);font-weight:445;line-height:18px;letter-spacing:normal;display:flex;flex-direction:column;opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease,visibility .12s;pointer-events:none}
        .popover.open{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
        .popover[data-mode="requests"]{width:min(420px,calc(100vw - 16px))}
        .popover-head{display:flex;align-items:center;justify-content:space-between;color:var(--color-token-text-tertiary,currentColor);height:24px}
        .popover-head-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit}
        .popover-refresh{appearance:none;display:grid;place-items:center;width:28px;height:28px;margin:-2px -6px -2px 0;padding:0;border:0;border-radius:7px;background:transparent;color:var(--color-token-text-tertiary,currentColor);cursor:pointer}
        .popover-refresh:hover{background:var(--color-background-button-tertiary-hover,rgba(127,127,127,.12));color:var(--color-token-text-primary,currentColor)}
        .popover-refresh:focus-visible{outline:2px solid var(--color-token-text-primary,currentColor);outline-offset:1px}
        .popover-refresh svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
        .popover-refresh[data-loading="true"] svg{animation:popover-refresh-spin .9s linear infinite}
        .popover-grid{display:grid;gap:6px;margin-top:8px}
        .popover[data-mode="requests"] .popover-grid{display:none}
        .popover-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;min-height:30px;padding:6px 9px;border-radius:8px;background:var(--color-background-button-tertiary,rgba(127,127,127,.04))}
        .popover-label{flex:0 0 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-token-text-tertiary,currentColor)}
        .popover-value{flex:1 1 auto;min-width:0;max-width:100%;overflow-wrap:anywhere;text-align:right;color:var(--color-token-text-primary,currentColor);font:inherit}
        .request-list{display:none;min-height:0;margin-top:8px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
        .popover[data-mode="requests"] .request-list{display:block}
        .request-item{padding:9px 4px;border-bottom:1px solid var(--color-token-border,rgba(127,127,127,.12))}
        .request-item:last-child{border-bottom:0}
        .request-main{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:10px;min-width:0}
        .request-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-token-text-primary,currentColor);font-weight:600}
        .request-timing{justify-self:center;color:var(--color-token-text-tertiary,currentColor);font-size:12px;font-weight:inherit;line-height:17px;font-variant-numeric:tabular-nums;white-space:nowrap}
        .request-age{min-width:0;justify-self:end;overflow:hidden;text-overflow:ellipsis;color:var(--color-token-text-tertiary,currentColor);font-size:12px;white-space:nowrap}
        .request-meta{display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px;min-width:0;margin-top:3px;color:var(--color-token-text-tertiary,currentColor);font-size:12px;line-height:17px}
        .request-meta>span:not(.request-cost):not(.request-error){min-width:0;overflow-wrap:anywhere}
        .request-cost{margin-left:auto;color:var(--color-token-text-primary,currentColor);white-space:nowrap}
        .request-error{color:var(--color-text-warning,#ff9f43);white-space:nowrap}
        .request-empty{padding:22px 4px;text-align:center;color:var(--color-token-text-tertiary,currentColor)}
        .hub-open{appearance:none;width:100%;height:34px;margin-top:9px;border:1px solid var(--color-token-border,rgba(127,127,127,.18));border-radius:9px;background:var(--color-background-button-tertiary,rgba(127,127,127,.06));color:var(--color-token-text-primary,currentColor);font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
        .hub-open:hover{background:var(--color-background-button-tertiary-hover,rgba(127,127,127,.12))}
        .hub-open svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
        .hub-open span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .hub-open .external-icon{width:12px;height:12px}
        .tooltip{position:fixed;z-index:2147483001;max-width:min(360px,calc(100vw - 16px));padding:7px 10px;border:1px solid var(--color-token-border,rgba(127,127,127,.18));border-radius:10px;background:var(--color-token-dropdown-background,rgb(38,38,38));box-shadow:0 8px 24px rgba(0,0,0,.28);color:var(--color-token-text-primary,#fff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:18px;white-space:normal;opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease,visibility .1s;pointer-events:none}
        .tooltip.open{opacity:1;visibility:visible;transform:translateY(0)}
        @keyframes popover-refresh-spin{to{transform:rotate(-360deg)}}
        @media (prefers-reduced-motion:reduce){.tooltip{transition:none}.popover-refresh[data-loading="true"] svg{animation:none}}
      </style><div id="popover" class="popover" data-mode="balance" role="dialog" aria-labelledby="popover-title" aria-hidden="true" tabindex="-1">
        <div class="popover-head"><span id="popover-title" class="popover-head-title">额度</span><button id="popover-refresh" class="popover-refresh" type="button" aria-label="刷新 CCSwitch 用量"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.22-6.49L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 15.22 6.49L21 16"></path><path d="M16 16h5v5"></path></svg></button></div>
        <div id="popover-grid" class="popover-grid"></div><div id="recent-requests" class="request-list" role="list"></div><button id="open-hub" class="hub-open" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.25"></rect><rect x="14" y="4" width="6" height="6" rx="1.25"></rect><rect x="4" y="14" width="6" height="6" rx="1.25"></rect><rect x="14" y="14" width="6" height="6" rx="1.25"></rect></svg><span>打开 All API Hub</span><svg class="external-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6"></path></svg></button>
      </div><div id="tooltip" class="tooltip" role="tooltip"></div>`;
      shadow.getElementById('open-hub').addEventListener('click', () => openHub());
      shadow.getElementById('popover-refresh').addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.popoverMode === 'requests') requestRecentRequests(state.popoverAnchor);
        else requestRefresh(state.popoverAnchor, false);
      });
    }
    state.popoverRoot = host;
    state.popoverShadow = host.shadowRoot;
    return state.popoverShadow;
  }

  function usageTitle(payload) {
    const values = [];
    if (payload.extra) values.push(payload.extra);
    const prefix = payload.periodLabel ? `${payload.periodLabel} ` : '';
    if (payload.used != null) values.push(`${prefix}已用 ${formatNumber(payload.used)} ${payload.unit || ''}`.trim());
    if (payload.remaining != null) values.push(`${prefix}剩余 ${formatNumber(payload.remaining)} ${payload.unit || ''}`.trim());
    if (payload.message) values.push(payload.message);
    if (payload.updatedAt) values.push(`更新于 ${formatUsageAge(payload.updatedAt)}`);
    if (payload.queryError) values.push('最近刷新失败，当前显示缓存数据');
    return values.filter(Boolean).join(' · ');
  }

  function popoverRows(payload) {
    const rows = [];
    if (payload.status === 'ok') {
      if (payload.extra) {
        const parts = String(payload.extra).split(/[，,；;|]+/).map(part => part.trim()).filter(Boolean);
        for (const part of parts) {
          const match = part.match(/^([^:：]+)[:：]\s*(.*)$/);
          rows.push(match ? [match[1], match[2]] : ['额度', part]);
        }
      }
      const prefix = payload.periodLabel ? `${payload.periodLabel} ` : '';
      if (payload.used != null) rows.push([`${prefix}已用`, `${formatNumber(payload.used)}${payload.unit ? ` ${payload.unit}` : ''}`]);
      if (payload.remaining != null) rows.push([`${prefix}剩余`, `${formatNumber(payload.remaining)}${payload.unit ? ` ${payload.unit}` : ''}`]);
      if (payload.updatedAt) rows.push(['更新于', formatUsageAge(payload.updatedAt)]);
      if (payload.queryError) rows.push(['查询状态', '最近刷新失败，当前为缓存数据']);
    } else {
      rows.push(['状态', payload.message || (payload.status === 'unsupported' ? '未配置用量' : '读取中…')]);
    }
    return rows;
  }

  function formatTokenCount(value) {
    const number = Math.max(0, Number(value) || 0);
    const compact = (divisor, suffix) => {
      const scaled = number / divisor;
      const digits = scaled >= 100 ? 0 : 1;
      return `${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`;
    };
    if (number >= 1_000_000) return compact(1_000_000, 'M');
    if (number >= 1_000) return compact(1_000, 'k');
    return String(Math.trunc(number));
  }

  function formatRequestCost(value, unit = 'USD') {
    if (value == null || value === '') return '--';
    const number = Math.max(0, Number(value) || 0);
    const normalizedUnit = String(unit || 'USD').trim().toUpperCase();
    const symbol = normalizedUnit === 'CNY' ? '¥' : normalizedUnit === 'USD' ? '$' : '';
    if (normalizedUnit === 'TOKENS') return `${formatTokenCount(number)} tokens`;
    if (number > 0 && number < 0.0001) return `<${symbol || ''}0.0001${symbol ? '' : ` ${unit}`}`.trim();
    const amount = number === 0 ? '0' : number.toFixed(number < 1 ? 4 : 2);
    return `${symbol}${amount}${symbol ? '' : ` ${unit}`}`.trim();
  }

  function requestMetadata(item) {
    const values = [
      `输入 ${formatTokenCount(item.inputTokens)}`,
      `输出 ${formatTokenCount(item.outputTokens)}`,
    ];
    if (Number(item.cacheReadTokens) > 0) values.push(`缓存 ${formatTokenCount(item.cacheReadTokens)}`);
    if (Number(item.cacheCreationTokens) > 0) values.push(`写缓存 ${formatTokenCount(item.cacheCreationTokens)}`);
    if (item.requestModel && item.model && item.requestModel !== item.model) values.push(`请求 ${item.requestModel}`);
    return values;
  }

  function positionPopover() {
    if (!state.popoverOpen || !state.popoverShadow) return;
    const anchor = state.popoverAnchor?.root?.isConnected
      ? state.popoverAnchor
      : { root: state.root, shadow: state.shadow };
    const button = state.popoverMode === 'requests'
      ? anchor.root?.__codexUsageHubButton
      : anchor.root?.__codexUsageRefreshButton;
    const popover = state.popoverShadow.querySelector('.popover');
    if (!button || !popover) return;
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - popoverRect.width - 8, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.bottom = `${Math.round(window.innerHeight - buttonRect.top + 10)}px`;
    popover.style.maxHeight = `${Math.max(160, Math.floor(buttonRect.top - 18))}px`;
  }

  function hideUsageTooltip() {
    if (state.tooltipTimer) clearTimeout(state.tooltipTimer);
    state.tooltipTimer = 0;
    state.popoverShadow?.getElementById('tooltip')?.classList.remove('open');
    state.tooltipAnchor = null;
  }

  function showUsageTooltip(instance, text, anchorElement = null) {
    if (!text || !instance?.root?.isConnected) return;
    const tooltip = ensurePopoverPortal().getElementById('tooltip');
    const usage = instance.root?.__codexUsageElement;
    if (!tooltip || !usage) return;
    state.tooltipAnchor = instance;
    tooltip.textContent = text;
    tooltip.classList.add('open');
    const contentRects = anchorElement ? [] : [...usage.querySelectorAll('.metric,.meter,.message')]
      .filter(element => getComputedStyle(element).display !== 'none')
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0);
    const anchorRect = anchorElement?.getBoundingClientRect() || (contentRects.length ? (() => {
      const left = Math.min(...contentRects.map(rect => rect.left));
      const right = Math.max(...contentRects.map(rect => rect.right));
      return { left, right, width: right - left, top: Math.min(...contentRects.map(rect => rect.top)) };
    })() : usage.getBoundingClientRect());
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - tooltipRect.width - 8, anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.bottom = `${Math.round(innerHeight - anchorRect.top + 2)}px`;
  }
  function syncMirrors(footers = null) {
    if (!state.shadow || !state.footer) return;
    const desiredFooters = footers?.filter(footer => footer !== state.footer) || state.mirrors.map(mirror => mirror.footer).filter(footer => footer?.isConnected);
    for (const mirror of [...state.mirrors]) {
      if (!mirror.footer?.isConnected || !desiredFooters.includes(mirror.footer)) removeMirror(mirror);
    }
    for (const footer of desiredFooters) {
      let mirror = state.mirrors.find(item => item.footer === footer);
      const parts = footerParts(footer);
      if (!parts) {
        if (mirror) removeMirror(mirror);
        continue;
      }
      if (!mirror) mirror = createMirror(footer);
      placeInNativeFlow(mirror.root, parts.right);
    }
    syncResizeObservation();
  }

  function createRefreshIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const pathData of ['M21 12a9 9 0 0 0-15.22-6.49L3 8', 'M3 3v5h5', 'M3 12a9 9 0 0 0 15.22 6.49L21 16', 'M16 16h5v5']) {
      const path = document.createElementNS(namespace, 'path');
      path.setAttribute('d', pathData);
      svg.appendChild(path);
    }
    return svg;
  }

  function createHubIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const [x, y] of [[4, 4], [14, 4], [4, 14], [14, 14]]) {
      const rect = document.createElementNS(namespace, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', '6');
      rect.setAttribute('height', '6');
      rect.setAttribute('rx', '1.25');
      svg.appendChild(rect);
    }
    return svg;
  }

  function publishPageAction(action) {
    state.actionToken += 1;
    document.title = enqueuePageActionTitle(document.title, {
      action,
      token: state.actionToken,
      requestedAt: Date.now(),
    }, pageActionSentinel);
  }

  function focusPopover() {
    if (!state.popoverOpen || !state.popoverShadow) return;
    const target = state.popoverMode === 'requests'
      ? state.popoverShadow.getElementById('open-hub')
      : state.popoverShadow.getElementById('popover-refresh');
    (target || state.popoverShadow.getElementById('popover'))?.focus?.({ preventScroll: true });
  }

  function closePopover(returnFocus = false) {
    const trigger = state.popoverTrigger;
    state.popoverOpen = false;
    state.popoverMode = '';
    state.popoverTrigger = null;
    render();
    if (returnFocus && trigger?.isConnected) trigger.focus?.({ preventScroll: true });
  }

  function openHub() {
    hideUsageTooltip();
    state.popoverOpen = false;
    state.popoverMode = '';
    state.popoverTrigger = null;
    state.popoverShadow?.querySelector('.popover')?.classList.remove('open');
    publishPageAction('open-hub');
  }

  function toggleRequestPopover(instance) {
    hideUsageTooltip();
    const samePopover = state.popoverOpen
      && state.popoverMode === 'requests'
      && state.popoverAnchor?.root === instance?.root;
    if (instance?.root?.isConnected) state.popoverAnchor = instance;
    if (samePopover) {
      closePopover(true);
      return;
    }
    state.popoverOpen = true;
    state.popoverMode = 'requests';
    state.popoverTrigger = instance?.root?.__codexUsageHubButton || null;
    requestRecentRequests(instance);
    render(null, true);
    focusPopover();
  }

  function requestRecentRequests(instance) {
    hideUsageTooltip();
    state.requestRefreshToken += 1;
    publishPageAction('refresh-requests');
    state.requestLoading = true;
    if (state.requestLoadingTimer) clearTimeout(state.requestLoadingTimer);
    const requestToken = state.requestRefreshToken;
    state.requestLoadingTimer = setTimeout(() => {
      if (state.requestRefreshToken !== requestToken) return;
      state.requestLoadingTimer = 0;
      state.requestLoading = false;
      render(null, false);
    }, REFRESH_LOADING_TIMEOUT_MS);
    if (instance?.root?.isConnected) state.popoverAnchor = instance;
    render(null, false);
  }

  function requestRefresh(instance, togglePopover = false) {
    hideUsageTooltip();
    state.refreshToken += 1;
    state.refreshRequestedAt = Date.now();
    publishPageAction('refresh');
    state.loading = true;
    if (state.refreshLoadingTimer) clearTimeout(state.refreshLoadingTimer);
    const refreshToken = state.refreshToken;
    state.refreshLoadingTimer = setTimeout(() => {
      if (state.refreshToken !== refreshToken) return;
      state.refreshLoadingTimer = 0;
      state.loading = false;
      render(null, false);
    }, REFRESH_LOADING_TIMEOUT_MS);
    if (instance?.root?.isConnected) state.popoverAnchor = instance;
    if (togglePopover) {
      const samePopover = state.popoverOpen && state.popoverMode === 'balance';
      state.popoverOpen = !samePopover;
      state.popoverMode = state.popoverOpen ? 'balance' : '';
      state.popoverTrigger = state.popoverOpen ? (instance?.root?.__codexUsageRefreshButton || null) : null;
    }
    render(null, togglePopover);
    if (togglePopover && state.popoverOpen) focusPopover();
  }

  function bindUsageEvents(instance, usage, hubButton, refreshButton) {
    usage.addEventListener('pointerover', event => {
      const tooltipTarget = findUsageTooltipTarget(event.target);
      if (!tooltipTarget || !isUsageTooltipBoundaryCrossing(event.target, event.relatedTarget, findUsageTooltipTarget)) return;
      if (state.tooltipTimer) clearTimeout(state.tooltipTimer);
      state.tooltipTimer = setTimeout(() => {
        state.tooltipTimer = 0;
        showUsageTooltip(instance, usage.getAttribute('aria-label') || '');
      }, 700);
    });
    usage.addEventListener('pointerout', event => {
      const tooltipTarget = findUsageTooltipTarget(event.target);
      if (!tooltipTarget || !isUsageTooltipBoundaryCrossing(event.target, event.relatedTarget, findUsageTooltipTarget)) return;
      hideUsageTooltip();
    });
    usage.addEventListener('focusin', event => {
      const tooltipTarget = findUsageTooltipTarget(event.target);
      if (tooltipTarget) showUsageTooltip(instance, usage.getAttribute('aria-label') || '', tooltipTarget);
    });
    usage.addEventListener('focusout', hideUsageTooltip);
    hubButton.addEventListener('pointerenter', () => {
      if (state.tooltipTimer) clearTimeout(state.tooltipTimer);
      state.tooltipTimer = setTimeout(() => {
        state.tooltipTimer = 0;
        showUsageTooltip(instance, '查看当前供应商最近请求', hubButton);
      }, 700);
    });
    hubButton.addEventListener('pointerleave', hideUsageTooltip);
    hubButton.addEventListener('focus', () => showUsageTooltip(instance, '查看当前供应商最近请求', hubButton));
    hubButton.addEventListener('blur', hideUsageTooltip);
    hubButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleRequestPopover(instance);
    });
    refreshButton.addEventListener('pointerenter', () => {
      if (state.tooltipTimer) clearTimeout(state.tooltipTimer);
      state.tooltipTimer = setTimeout(() => {
        state.tooltipTimer = 0;
        showUsageTooltip(instance, '刷新用量', refreshButton);
      }, 700);
    });
    refreshButton.addEventListener('pointerleave', hideUsageTooltip);
    refreshButton.addEventListener('focus', () => showUsageTooltip(instance, '刷新用量', refreshButton));
    refreshButton.addEventListener('blur', hideUsageTooltip);
    refreshButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      requestRefresh(instance, instance.root.dataset.mode === 'icon');
    });
  }

  function ensureUsageElement(instance) {
    let usage = instance.root.__codexUsageElement;
    if (usage && usage.getRootNode() !== instance.shadow) usage = null;
    if (!usage) usage = instance.shadow.querySelector('.usage');
    if (usage) {
      if (!usage.__codexUsageHubButton) usage.__codexUsageHubButton = usage.querySelector('.hub-trigger');
      if (!usage.__codexUsageRefreshButton) usage.__codexUsageRefreshButton = usage.querySelector('.refresh');
      instance.root.__codexUsageElement = usage;
      instance.root.__codexUsageHubButton = usage.__codexUsageHubButton;
      instance.root.__codexUsageRefreshButton = usage.__codexUsageRefreshButton;
      return usage;
    }
    usage = document.createElement('div');
    usage.className = 'usage';
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.setAttribute('aria-hidden', 'true');
    const hubButton = document.createElement('button');
    hubButton.className = 'toolbar-action hub-trigger';
    hubButton.type = 'button';
    hubButton.setAttribute('aria-label', '查看当前供应商最近请求');
    hubButton.setAttribute('aria-haspopup', 'dialog');
    hubButton.setAttribute('aria-expanded', 'false');
    hubButton.appendChild(createHubIcon());
    const refreshButton = document.createElement('button');
    refreshButton.className = 'toolbar-action refresh';
    refreshButton.type = 'button';
    refreshButton.setAttribute('aria-label', '刷新 CCSwitch 用量');
    refreshButton.setAttribute('aria-haspopup', 'dialog');
    refreshButton.setAttribute('aria-expanded', 'false');
    refreshButton.appendChild(createRefreshIcon());
    usage.append(dot, hubButton, refreshButton);
    usage.__codexUsageHubButton = hubButton;
    usage.__codexUsageRefreshButton = refreshButton;
    instance.root.__codexUsageElement = usage;
    instance.root.__codexUsageHubButton = hubButton;
    instance.root.__codexUsageRefreshButton = refreshButton;
    instance.shadow.getElementById('content').replaceChildren(usage);
    bindUsageEvents(instance, usage, hubButton, refreshButton);
    return usage;
  }

  function dynamicElement(tagName, className, text = '') {
    const element = document.createElement(tagName);
    element.dataset.usageDynamic = 'true';
    element.className = className;
    element.textContent = text;
    return element;
  }

  function buildUsageElements(payload, balanceLevel) {
    const elements = [];
    if (payload.status !== 'ok') {
      elements.push(dynamicElement('span', 'message', payload.message || (payload.status === 'unsupported' ? '未配置用量' : '读取中…')));
      return elements;
    }
    if (payload.extra) {
      const parts = String(payload.extra).split(/[，,；;|]+/).map(part => part.trim()).filter(Boolean);
      parts.forEach((part, index) => elements.push(dynamicElement('span', `metric extra ${index > 0 ? 'extra-secondary' : ''}`.trim(), part)));
    }
    const used = formatNumber(payload.used);
    const remaining = formatNumber(payload.remaining);
    const unit = String(payload.unit || '');
    const periodLabel = String(payload.periodLabel || '');
    const percent = payload.total > 0 && payload.used != null ? Math.max(0, Math.min(100, payload.used / payload.total * 100)) : 0;
    if (used) elements.push(dynamicElement('span', 'metric used', `${periodLabel ? `${periodLabel}已用 ` : '已用 '}${used}`));
    if (payload.total > 0 && payload.used != null) {
      const meter = dynamicElement('span', 'meter');
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-label', `${payload.providerName || '额度'}${periodLabel ? ` ${periodLabel}` : ''}用量`);
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-valuenow', percent.toFixed(1));
      meter.setAttribute('aria-valuetext', `已用 ${percent.toFixed(1)}%，剩余 ${remaining || '未知'}${unit ? ` ${unit}` : ''}`);
      meter.dataset.balanceLevel = balanceLevel;
      const fill = document.createElement('i');
      fill.style.width = `${percent.toFixed(1)}%`;
      meter.appendChild(fill);
      elements.push(meter);
    }
    if (remaining) {
      const remainingElement = dynamicElement('span', 'metric remaining');
      remainingElement.appendChild(document.createTextNode(periodLabel ? '剩 ' : '剩余 '));
      const remainingValue = document.createElement('span');
      remainingValue.className = 'remaining-value';
      remainingValue.textContent = remaining;
      remainingElement.appendChild(remainingValue);
      if (unit) remainingElement.appendChild(document.createTextNode(` ${unit}`));
      elements.push(remainingElement);
    }
    return elements;
  }

  function renderInstance(instance, payload, balanceLevel) {
    if (!instance?.shadow || !instance.root?.isConnected) return;
    const usage = ensureUsageElement(instance);
    const view = state.__codexUsageView;
    updateElementAttribute(usage, 'data-status', payload.status || 'loading');
    updateElementAttribute(usage, 'data-query-error', payload.queryError ? 'true' : 'false');
    updateElementAttribute(usage, 'data-freshness', view.freshness);
    updateElementAttribute(usage, 'data-balance-level', balanceLevel);
    updateElementAttribute(usage, 'aria-label', view.title);
    const refreshButton = usage.__codexUsageRefreshButton;
    const hubButton = usage.__codexUsageHubButton;
    updateElementAttribute(refreshButton, 'data-loading', state.loading ? 'true' : null);
    const ownsPopover = state.popoverAnchor?.root === instance.root;
    updateElementAttribute(hubButton, 'aria-expanded', ownsPopover && state.popoverOpen && state.popoverMode === 'requests' ? 'true' : 'false');
    updateElementAttribute(refreshButton, 'aria-expanded', ownsPopover && state.popoverOpen && state.popoverMode === 'balance' ? 'true' : 'false');
    if (instance.root.__codexUsageContentSignature === view.contentSignature) return;
    instance.root.__codexUsageMeasurements = null;
    for (const child of [...usage.children]) {
      if (child.dataset.usageDynamic === 'true') child.remove();
    }
    for (const element of buildUsageElements(payload, balanceLevel)) usage.insertBefore(element, hubButton);
    instance.root.__codexUsageContentSignature = view.contentSignature;
  }

  function renderPopoverRows(portal, payload) {
    if (state.popoverPayload === payload) return;
    const grid = portal.getElementById('popover-grid');
    const elements = popoverRows(payload).map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'popover-row';
      const labelElement = document.createElement('span');
      labelElement.className = 'popover-label';
      labelElement.textContent = label;
      const valueElement = document.createElement('span');
      valueElement.className = 'popover-value';
      valueElement.textContent = value;
      row.append(labelElement, valueElement);
      return row;
    });
    grid.replaceChildren(...elements);
    state.popoverPayload = payload;
  }

  function renderRecentRequests(portal, payload) {
    const ageMinute = Math.floor(Date.now() / 60_000);
    if (state.recentRequestsPayload === payload && state.recentRequestsAgeMinute === ageMinute) return;
    const list = portal.getElementById('recent-requests');
    const requests = Array.isArray(payload.recentRequests) ? payload.recentRequests.slice(0, 10) : [];
    if (requests.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'request-empty';
      empty.textContent = state.requestLoading || payload.recentRequestsLoading
        ? '正在读取最新 10 条调用记录…'
        : '当前供应商还没有 Codex 请求记录';
      list.replaceChildren(empty);
      state.recentRequestsPayload = payload;
      state.recentRequestsAgeMinute = ageMinute;
      return;
    }

    const rows = requests.map(item => {
      const row = document.createElement('div');
      row.className = 'request-item';
      row.setAttribute('role', 'listitem');
      const main = document.createElement('div');
      main.className = 'request-main';
      const model = document.createElement('span');
      model.className = 'request-model';
      model.textContent = item.model || item.requestModel || '未知模型';
      if (item.requestModel && item.model && item.requestModel !== item.model) {
        model.title = `请求 ${item.requestModel}，实际 ${item.model}`;
      }
      const timing = document.createElement('span');
      timing.className = 'request-timing';
      timing.textContent = `${formatRequestTime(item.latencyMs)}/${formatRequestTime(item.firstTokenMs)}`;
      const age = document.createElement('span');
      age.className = 'request-age';
      age.textContent = formatUsageAge(item.createdAt);
      main.append(model, timing, age);

      const metadata = document.createElement('div');
      metadata.className = 'request-meta';
      for (const value of requestMetadata(item)) {
        const part = document.createElement('span');
        part.textContent = value;
        metadata.appendChild(part);
      }
      const hasStatusCode = item.statusCode != null && item.statusCode !== '' && Number.isFinite(Number(item.statusCode));
      const statusCode = hasStatusCode ? Number(item.statusCode) : 0;
      if (item.success === false || (hasStatusCode && (statusCode < 200 || statusCode >= 400))) {
        const status = document.createElement('span');
        status.className = 'request-error';
        status.textContent = statusCode ? `HTTP ${statusCode}` : '请求失败';
        metadata.appendChild(status);
      }
      const cost = document.createElement('span');
      cost.className = 'request-cost';
      cost.textContent = formatRequestCost(item.totalCost ?? item.totalCostUsd, item.costUnit || 'USD');
      cost.title = item.costExact === true
        ? '第三方实际扣费'
        : item.costSource === 'ccswitch_local' ? 'CCSwitch 本地估算' : '第三方未返回可换算费用';
      metadata.appendChild(cost);
      row.append(main, metadata);
      return row;
    });
    list.replaceChildren(...rows);
    state.recentRequestsPayload = payload;
    state.recentRequestsAgeMinute = ageMinute;
  }

  function render(footers = null, shouldScheduleLayout = true) {
    if (!state.shadow) return;
    const payload = state.payload || { status: 'loading', providerName: '' };
    let view = state.__codexUsageView;
    if (!view || view.payload !== payload) {
      let balanceLevel = 'normal';
      if (payload.status === 'ok') {
        const remainingPercent = payload.total > 0 && payload.remaining != null
          ? Math.max(0, Math.min(100, payload.remaining / payload.total * 100))
          : null;
        balanceLevel = remainingPercent == null ? 'normal' : remainingPercent < 10 ? 'critical' : remainingPercent <= 20 ? 'warning' : 'normal';
      }
      view = { payload, balanceLevel, freshness: '', title: '', contentSignature: balancePayloadSignature(payload) };
      state.__codexUsageView = view;
    }
    view.freshness = getUsageFreshness(payload);
    view.title = usageTitle(payload);

    syncMirrors(footers);
    renderInstance({ footer: state.footer, root: state.root, shadow: state.shadow }, payload, view.balanceLevel);
    for (const mirror of state.mirrors) renderInstance(mirror, payload, view.balanceLevel);
    const portal = state.popoverShadow || (state.popoverOpen ? ensurePopoverPortal() : null);
    if (portal) {
      const popover = portal.getElementById('popover');
      const popoverMode = state.popoverOpen
        ? (state.popoverMode || 'balance')
        : (popover.getAttribute('data-mode') || 'balance');
      popover.classList.toggle('open', state.popoverOpen);
      updateElementAttribute(popover, 'aria-hidden', state.popoverOpen ? 'false' : 'true');
      updateElementAttribute(popover, 'data-mode', popoverMode);
      updateElementAttribute(popover, 'aria-label', popoverMode === 'requests' ? '当前供应商最近请求' : '完整额度');
      const requestProviderName = payload.providerDisplayName || payload.providerName || '当前供应商';
      const requestProviderLabel = payload.accountBrowser
        ? `${requestProviderName}（${payload.accountBrowser}）`
        : requestProviderName;
      portal.querySelector('.popover-head-title').textContent = popoverMode === 'requests'
        ? `${requestProviderLabel} · 最近 10 条 Codex 调用`
        : '额度';
      const popoverRefreshButton = portal.getElementById('popover-refresh');
      const popoverLoading = popoverMode === 'requests'
        ? (state.requestLoading || payload.recentRequestsLoading === true)
        : state.loading;
      updateElementAttribute(popoverRefreshButton, 'data-loading', popoverLoading ? 'true' : null);
      updateElementAttribute(popoverRefreshButton, 'aria-busy', popoverLoading ? 'true' : null);
      updateElementAttribute(popoverRefreshButton, 'aria-label', popoverMode === 'requests' ? '刷新最近 10 条 Codex 调用' : '刷新 CCSwitch 用量');
      renderPopoverRows(portal, payload);
      renderRecentRequests(portal, payload);
    }
    if (shouldScheduleLayout) scheduleLayout();
  }

  function findRightToolbar(right) {
    const anchor = right.querySelector('[aria-label^="上下文用量"], [data-codex-intelligence-trigger="true"], [data-composer-navigation-target="reasoning"]');
    let current = anchor;
    while (current?.parentElement && current.parentElement !== right) {
      current = current.parentElement;
      if (current.tagName === 'DIV' && getComputedStyle(current).display === 'flex') return current;
    }
    return null;
  }

  function setStyleIfChanged(style, property, value) {
    if (style[property] !== value) style[property] = value;
  }

  function invalidateNativeFlowCaches() {
    if (state.root) state.root.__codexUsageNativeFlow = null;
    for (const mirror of state.mirrors) mirror.root.__codexUsageNativeFlow = null;
  }

  function placeInNativeFlow(root, right) {
    let flow = root.__codexUsageNativeFlow;
    if (!isNativeFlowCacheValid(flow, root, right, getComputedStyle)) {
      const toolbar = findRightToolbar(right);
      const { lane, before } = resolveNativeFlowPlacement(right, root, toolbar, getComputedStyle);
      const signature = element => {
        if (!element) return '';
        const style = getComputedStyle(element);
        return [style.display || '', style.flexGrow || '', style.flexShrink || ''].join(':');
      };
      flow = { right, lane, before, signature: `${signature(lane)}|${signature(lane?.parentElement)}` };
      root.__codexUsageNativeFlow = flow;
    }
    const { lane, before } = flow;
    if (root.parentElement !== lane || root.nextElementSibling !== before) lane.insertBefore(root, before || null);
    setStyleIfChanged(lane.style, 'minWidth', '0px');
    setStyleIfChanged(root.style, 'position', 'relative');
    setStyleIfChanged(root.style, 'left', '0px');
    setStyleIfChanged(root.style, 'top', '0px');
    setStyleIfChanged(root.style, 'flex', '1 999 399px');
    setStyleIfChanged(root.style, 'width', 'auto');
    setStyleIfChanged(root.style, 'minWidth', '28px');
    setStyleIfChanged(root.style, 'maxWidth', 'none');
    setStyleIfChanged(root.style, 'marginRight', '0px');
    return lane;
  }

  function responsiveMeasurementSignature(root) {
    const style = getComputedStyle(root);
    return [
      style.fontFamily,
      style.fontSize,
      style.fontStyle,
      style.fontWeight,
      style.letterSpacing,
      style.lineHeight,
      style.getPropertyValue('--spacing-token-button-composer-gap'),
      window.devicePixelRatio,
    ].join('|');
  }

  function measureResponsiveModes(root, usage, refresh, signature) {
    const previousMode = root.dataset.mode || 'full';
    const modeMetrics = {};
    try {
      for (const candidate of responsiveModes) {
        root.dataset.mode = candidate;
        const usageRect = usage.getBoundingClientRect();
        const refreshRect = refresh?.getBoundingClientRect();
        const visibleChildren = [...usage.children].filter(element => getComputedStyle(element).display !== 'none');
        const usageStyle = getComputedStyle(usage);
        const gap = Number.parseFloat(usageStyle.columnGap || usageStyle.gap) || 0;
        const requiredWidth = visibleChildren.reduce(
          (total, element) => total + Math.max(element.scrollWidth, element.getBoundingClientRect().width),
          0,
        ) + Math.max(0, visibleChildren.length - 1) * gap;
        modeMetrics[candidate] = {
          requiredWidth,
          refreshRightOffset: refreshRect
            ? refreshRect.right - (usageRect.left + usageRect.width / 2)
            : null,
        };
      }
    } finally {
      root.dataset.mode = previousMode;
    }
    const measurements = { signature, modeMetrics };
    root.__codexUsageMeasurements = measurements;
    root.__codexUsageMeasurementRuns = (root.__codexUsageMeasurementRuns || 0) + 1;
    return measurements;
  }

  function invalidateResponsiveMeasurements() {
    if (state.root) state.root.__codexUsageMeasurements = null;
    for (const mirror of state.mirrors) mirror.root.__codexUsageMeasurements = null;
    scheduleLayout();
  }

  function scheduleResponsiveSettle() {
    if (state.resizeSettleTimer) clearTimeout(state.resizeSettleTimer);
    state.resizeSettleTimer = setTimeout(() => {
      state.resizeSettleTimer = 0;
      if (state.root?.__codexUsageResizeState) state.root.__codexUsageResizeState.direction = 'settled';
      for (const mirror of state.mirrors) {
        if (mirror.root.__codexUsageResizeState) mirror.root.__codexUsageResizeState.direction = 'settled';
      }
      scheduleLayout();
    }, 180);
  }

  function invalidateResponsiveDirections() {
    if (state.root) state.root.__codexUsageResizeState = null;
    for (const mirror of state.mirrors) mirror.root.__codexUsageResizeState = null;
  }

  function layoutRoot(footer, root) {
    const parts = footerParts(footer);
    if (!footer?.isConnected || !root?.isConnected || !parts) return;
    const { right } = parts;
    placeInNativeFlow(root, right);
    const usage = root.__codexUsageElement;
    const previousMode = root.dataset.mode;
    const refresh = root.__codexUsageRefreshButton;
    const native = root.nextElementSibling;
    if (!usage) return;
    const signature = responsiveMeasurementSignature(root);
    let cached = root.__codexUsageMeasurements;
    if (!cached || cached.signature !== signature) cached = measureResponsiveModes(root, usage, refresh, signature);
    const usageRect = usage.getBoundingClientRect();
    const nativeRect = native?.getBoundingClientRect();
    const measurements = calculateResponsiveMeasurements(cached.modeMetrics, {
      usageLeft: usageRect.left,
      usageWidth: usageRect.width,
      clientWidth: root.clientWidth,
      nativeLeft: nativeRect?.left ?? null,
    });
    const selectedMode = selectResponsiveUsageMode(measurements, previousMode);
    const constraintWidth = footer.getBoundingClientRect().width;
    const resizeState = root.__codexUsageResizeState || {
      width: constraintWidth,
      direction: 'settled',
    };
    const stabilized = stabilizeResponsiveUsageMode(
      selectedMode,
      previousMode,
      constraintWidth,
      resizeState.width,
      resizeState.direction,
    );
    if (Math.abs(constraintWidth - resizeState.width) > 0.5) scheduleResponsiveSettle();
    root.__codexUsageResizeState = { width: constraintWidth, direction: stabilized.direction };
    const mode = stabilized.mode;
    root.dataset.mode = mode;
    if (previousMode && previousMode !== mode && usage && !reducedMotionQuery.matches) {
      for (const animation of usage.getAnimations()) animation.cancel();
      usage.animate(
        [{ opacity: 0.58, transform: 'translateX(-2px)' }, { opacity: 1, transform: 'translateX(0)' }],
        { duration: 120, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
    const popoverAnchorUnavailable = state.popoverOpen
      && state.popoverAnchor?.root === root
      && (
        (state.popoverMode === 'balance' && mode !== 'icon')
        || (state.popoverMode === 'requests' && mode === 'icon')
      );
    if (popoverAnchorUnavailable) {
      state.popoverOpen = false;
      state.popoverMode = '';
      state.popoverShadow?.querySelector('.popover')?.classList.remove('open');
    }
  }

  function layout() {
    layoutRoot(state.footer, state.root);
    for (const mirror of state.mirrors) layoutRoot(mirror.footer, mirror.root);
  }

  function scheduleLayout() {
    if (state.layoutFrame) return;
    state.layoutFrame = requestAnimationFrame(() => {
      state.layoutFrame = 0;
      layout();
      positionPopover();
    });
  }

  function observeRelevantMutations() {
    if (!state.observer) return;
    const target = findMutationObserverTarget(state.footer, document);
    if (!target || target === state.observerTarget) return;
    state.observer.disconnect();
    state.observerTarget = target;
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function seedRootResizeSizes(roots) {
    for (const root of roots) {
      const rect = root.getBoundingClientRect();
      state.rootResizeSizes.set(root, { width: rect.width, height: rect.height });
    }
  }

  function hasMeaningfulRootResize(entries, roots) {
    let changed = false;
    for (const entry of entries) {
      if (!roots.includes(entry.target)) continue;
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      const previous = state.rootResizeSizes.get(entry.target);
      if (
        !previous
        || Math.abs(next.width - previous.width) > 0.5
        || Math.abs(next.height - previous.height) > 0.5
      ) {
        state.rootResizeSizes.set(entry.target, next);
        changed = true;
      }
    }
    return changed;
  }

  function rootResizeNeedsLayout(root) {
    if (!root?.isConnected) return false;
    if (state.popoverOpen && state.popoverAnchor?.root === root) return true;
    const cached = root.__codexUsageMeasurements;
    const previousMode = root.dataset.mode;
    if (!cached?.modeMetrics || !previousMode) return true;
    const width = root.clientWidth;
    const measurements = Object.fromEntries(Object.entries(cached.modeMetrics).map(([mode, metric]) => {
      const spare = width - Number(metric.requiredWidth || 0);
      return [mode, { fits: spare >= -0.5, spare }];
    }));
    const selected = selectResponsiveUsageMode(measurements, previousMode);
    return selected !== previousMode;
  }

  function syncResizeObservation() {
    const elements = [];
    const addInstance = (footer, root) => {
      const parts = footerParts(footer);
      if (!footer?.isConnected || !root?.isConnected || !parts) return;
      elements.push(footer, parts.left, parts.middle, parts.right, root);
    };
    addInstance(state.footer, state.root);
    for (const mirror of state.mirrors) addInstance(mirror.footer, mirror.root);
    const uniqueElements = [...new Set(elements)];
    const roots = [state.root, ...state.mirrors.map(mirror => mirror.root)].filter(Boolean);
    const unchanged = state.resizeObserver
      && uniqueElements.length === state.resizeObservedElements.length
      && uniqueElements.every((element, index) => element === state.resizeObservedElements[index] && element?.isConnected);
    if (unchanged) return;
    state.resizeObserver?.disconnect();
    if (!state.resizeObserver) state.resizeObserver = new ResizeObserver(entries => {
      const roots = [state.root, ...state.mirrors.map(mirror => mirror.root)].filter(Boolean);
      const rootChanged = hasMeaningfulRootResize(entries, roots);
      const nativeFlowChanged = roots.some(root => {
        const flow = root.__codexUsageNativeFlow;
        return flow && !isNativeFlowCacheValid(flow, root, flow.right, getComputedStyle);
      });
      const collapsed = entries.some(entry => (
        (entry.target === state.footer || entry.target === state.root || state.mirrors.some(mirror => entry.target === mirror.footer || entry.target === mirror.root))
        && (entry.contentRect.width <= 0 || entry.contentRect.height <= 0)
      ));
      if (collapsed) {
        const recovered = recoverComposerNow();
        if (recovered) scheduleLayout();
        return;
      }
      if (!rootChanged && !nativeFlowChanged) return;
      if (nativeFlowChanged || roots.some(rootResizeNeedsLayout)) scheduleLayout();
    });
    state.resizeObservedElements = uniqueElements;
    seedRootResizeSizes(roots);
    for (const element of uniqueElements) state.resizeObserver.observe(element);
  }

  function resetTransientUiForMissingComposer() {
    hideUsageTooltip();
    state.popoverOpen = false;
    state.popoverMode = '';
    state.popoverTrigger = null;
    state.popoverAnchor = null;
    const popover = state.popoverShadow?.getElementById('popover');
    popover?.classList.remove('open');
    updateElementAttribute(popover, 'aria-hidden', 'true');
  }

  function mount(forceScan = false) {
    if (forceScan) {
      invalidateNativeFlowCaches();
      invalidateResponsiveDirections();
    }
    if (!forceScan && state.footer?.isConnected && state.root?.isConnected) {
      render();
      return true;
    }
    const footers = findFooters();
    const footer = state.footer?.isConnected && footers.includes(state.footer)
      ? state.footer
      : [...footers].sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0];
    const parts = footerParts(footer);
    if (!footer || !parts) {
      resetTransientUiForMissingComposer();
      return false;
    }
    let root = document.getElementById(ROOT_ID);
    if (!root) root = createRoot();
    placeInNativeFlow(root, parts.right);
    state.footer = footer;
    observeRelevantMutations();
    render(footers);
    return true;
  }

  function recoverComposerNow() {
    const mounted = mount(true);
    if (mounted && state.composerSyncFrame) {
      cancelAnimationFrame(state.composerSyncFrame);
      state.composerSyncFrame = 0;
    }
    return mounted;
  }

  function scheduleComposerSync() {
    if (state.footer?.isConnected && state.root?.isConnected && footerParts(state.footer)) return;
    if (state.composerSyncFrame) return;
    state.composerSyncFrame = requestAnimationFrame(() => {
      state.composerSyncFrame = 0;
      recoverComposerNow();
    });
  }

  function recoverOnActivation() {
    scheduleComposerSync();
  }

  state.update = payload => {
    const balanceChanged = balancePayloadSignature(state.payload) !== balancePayloadSignature(payload);
    state.payload = payload;
    state.loading = false;
    if (state.refreshLoadingTimer) clearTimeout(state.refreshLoadingTimer);
    state.refreshLoadingTimer = 0;
    if (payload?.recentRequestsLoading !== true) {
      state.requestLoading = false;
      if (state.requestLoadingTimer) clearTimeout(state.requestLoadingTimer);
      state.requestLoadingTimer = 0;
    }
    if (state.footer?.isConnected && state.root?.isConnected) {
      render(null, balanceChanged);
      if (state.popoverOpen && !balanceChanged) positionPopover();
    } else {
      mount();
    }
    return true;
  };
  state.mount = mount;
  state.getRefreshToken = () => state.refreshToken;
  state.getRefreshRequest = () => ({ token: state.refreshToken, requestedAt: state.refreshRequestedAt });
  state.setPopoverOpen = open => {
    state.popoverOpen = Boolean(open);
    state.popoverMode = state.popoverOpen ? (state.popoverMode || 'balance') : '';
    if (!state.popoverOpen) state.popoverTrigger = null;
    if (!state.popoverAnchor) state.popoverAnchor = { root: state.root, shadow: state.shadow };
    render();
    return state.popoverOpen;
  };
  state.observer = new MutationObserver(records => {
    const mutationAction = classifyComposerMutations(records, state.footer, state.root);
    if (mutationAction === 'mount') recoverComposerNow();
  });
  observeRelevantMutations();
  state.themeObserver = new MutationObserver(() => {
    invalidateResponsiveMeasurements();
  });
  state.themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  document.addEventListener('pointerdown', event => {
    const path = event.composedPath();
    const insideUsage = path.includes(state.root) || state.mirrors.some(mirror => path.includes(mirror.root));
    if (!state.popoverOpen || insideUsage || path.includes(state.popoverRoot)) return;
    closePopover(false);
  }, { capture: true, signal: state.eventController.signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !state.popoverOpen) return;
    closePopover(true);
  }, { signal: state.eventController.signal });
  document.fonts?.addEventListener?.('loadingdone', invalidateResponsiveMeasurements, { signal: state.eventController.signal });
  document.fonts?.ready?.then(() => {
    if (!state.eventController.signal.aborted) invalidateResponsiveMeasurements();
  });
  window.addEventListener('resize', scheduleLayout, { passive: true, signal: state.eventController.signal });
  window.addEventListener('pageshow', recoverOnActivation, { signal: state.eventController.signal });
  window.addEventListener('focus', recoverOnActivation, { signal: state.eventController.signal });
  window.addEventListener('popstate', scheduleComposerSync, { signal: state.eventController.signal });
  window.addEventListener('hashchange', scheduleComposerSync, { signal: state.eventController.signal });
  window.navigation?.addEventListener?.('navigatesuccess', scheduleComposerSync, { signal: state.eventController.signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverOnActivation();
  }, { signal: state.eventController.signal });
  window[GLOBAL] = state;
  return mount();
}

export function buildInjectorScript() {
  return `(${installCodexUsageExtension.toString()})(${findUsageTooltipTarget.toString()},${isUsageTooltipBoundaryCrossing.toString()},${getUsageFreshness.toString()},${formatUsageAge.toString()},${formatRequestTime.toString()},${selectResponsiveUsageMode.toString()},${calculateResponsiveMeasurements.toString()},${stabilizeResponsiveUsageMode.toString()},${findMutationObserverTarget.toString()},${classifyComposerMutations.toString()},${createInjectorEventController.toString()},${updateElementAttribute.toString()},${isComposerFooterCandidate.toString()},${isNativeFlowCacheValid.toString()},${resolveNativeFlowPlacement.toString()},${enqueuePageActionTitle.toString()},${JSON.stringify(PAGE_ACTION_SENTINEL)},${INJECTOR_VERSION})`;
}

export const UPDATE_GLOBAL = '__CODEX_CCSWITCH_USAGE__';
