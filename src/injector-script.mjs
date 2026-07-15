export function findUsageTooltipTarget(target) {
  if (!target?.closest || target.closest('.refresh,.hub-open')) return null;
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
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    for (let listIndex = 0; listIndex < 2; listIndex += 1) {
      const nodes = listIndex === 0 ? record.addedNodes : record.removedNodes;
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        if (node?.nodeType !== 1) continue;
        if (
          (listIndex === 1 && (
            node === footer
            || node === root
            || node.contains?.(footer)
            || node.contains?.(root)
          ))
          || node.matches?.(selector)
          || node.querySelector?.(selector)
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

export function isNativeFlowCacheValid(cache, root, right) {
  return Boolean(
    cache
    && cache.right === right
    && cache.lane?.isConnected
    && (cache.before == null || cache.before.isConnected)
    && root?.parentElement === cache.lane
    && root?.nextElementSibling === cache.before
  );
}

export const PAGE_ACTION_SENTINEL = '\u2063\u2063';
export const INJECTOR_VERSION = 61;

function installCodexUsageExtension(findUsageTooltipTarget, isUsageTooltipBoundaryCrossing, getUsageFreshness, formatUsageAge, selectResponsiveUsageMode, calculateResponsiveMeasurements, stabilizeResponsiveUsageMode, findMutationObserverTarget, classifyComposerMutations, createInjectorEventController, updateElementAttribute, isNativeFlowCacheValid, pageActionSentinel, version) {
  const VERSION = version;
  const GLOBAL = '__CODEX_CCSWITCH_USAGE__';
  const ROOT_ID = 'codex-ccswitch-usage-root';
  const POPOVER_ID = 'codex-ccswitch-usage-popover';
  const existing = window[GLOBAL];
  if (existing?.version === VERSION) {
    existing.mount();
    return true;
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
    loading: false,
    popoverRoot: null,
    popoverShadow: null,
    layoutTimers: [],
    mirrors: [],
    nextRootId: 1,
    popoverAnchor: null,
    tooltipAnchor: null,
    tooltipTimer: 0,
    popoverPayload: null,
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
      if (rect.width <= 0 || rect.height < 20 || rect.height > 52) continue;
      if (rect.top < editorRect.bottom - 24) continue;
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
    .usage{height:28px;display:flex;align-items:center;justify-content:center;gap:var(--spacing-token-button-composer-gap,4px);min-width:0;overflow:hidden;white-space:nowrap;color:var(--color-token-text-tertiary,var(--color-text-foreground-tertiary,currentColor));font-family:inherit;font-size:var(--text-sm,13px);font-weight:inherit;line-height:18px;letter-spacing:normal;cursor:pointer}
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
    .refresh{appearance:none;border:0;background:transparent;color:inherit;width:28px;height:28px;padding:6px;display:grid;place-items:center;border-radius:9999px;cursor:pointer;flex:0 0 auto;font:inherit;line-height:18px}
    .refresh:hover{background:var(--color-background-button-tertiary-hover,rgba(127,127,127,.08))}
    .refresh svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .refresh[data-loading="true"] svg{animation:codex-usage-spin .8s linear infinite}
    .message{overflow:hidden;text-overflow:ellipsis;color:inherit;font:inherit}
    @keyframes codex-usage-spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){:host{transition:none}.refresh svg{animation:none!important}}
    :host([data-mode="compact"]) .extra-secondary{display:none}
    :host([data-mode="no-extra"]) .extra{display:none}
    :host([data-mode="no-used"]) .extra,:host([data-mode="no-used"]) .used{display:none}
    :host([data-mode="no-meter"]) .extra,:host([data-mode="no-meter"]) .used,:host([data-mode="no-meter"]) .meter{display:none}
    :host([data-mode="no-dot"]) .extra,:host([data-mode="no-dot"]) .used,:host([data-mode="no-dot"]) .meter,:host([data-mode="no-dot"]) .status-dot{display:none}
    :host([data-mode="icon"]) .status-dot,:host([data-mode="icon"]) .metric,:host([data-mode="icon"]) .meter,:host([data-mode="icon"]) .message{display:none}
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
        .popover{position:fixed;z-index:2147483000;width:min(236px,calc(100vw - 16px));padding:12px;border:1px solid var(--color-token-border,var(--color-token-button-border,rgba(127,127,127,.16)));border-radius:14px;background:var(--color-token-dropdown-background,rgb(38,38,38));box-shadow:0 12px 32px rgba(0,0,0,.32);color:var(--color-token-text-primary,currentColor);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:var(--text-sm,13px);font-weight:445;line-height:18px;letter-spacing:normal;opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease,visibility .12s;pointer-events:none}
        .popover.open{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
        .popover-head{display:flex;align-items:center;justify-content:space-between;color:var(--color-token-text-tertiary,currentColor);height:20px}
        .popover-head-title{font:inherit}
        .popover-head-icon{width:16px;height:16px;color:var(--color-token-text-tertiary,currentColor);fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
        .popover-grid{display:grid;gap:6px;margin-top:8px}
        .popover-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:30px;padding:0 9px;border-radius:8px;background:var(--color-background-button-tertiary,rgba(127,127,127,.04))}
        .popover-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-token-text-tertiary,currentColor)}
        .popover-value{flex:0 0 auto;color:var(--color-token-text-primary,currentColor);font:inherit}
        .hub-open{appearance:none;width:100%;height:34px;margin-top:9px;border:1px solid var(--color-token-border,rgba(127,127,127,.18));border-radius:9px;background:var(--color-background-button-tertiary,rgba(127,127,127,.06));color:var(--color-token-text-primary,currentColor);font:inherit;cursor:pointer}
        .hub-open:hover{background:var(--color-background-button-tertiary-hover,rgba(127,127,127,.12))}
        .tooltip{position:fixed;z-index:2147483001;max-width:min(360px,calc(100vw - 16px));padding:7px 10px;border:1px solid var(--color-token-border,rgba(127,127,127,.18));border-radius:10px;background:var(--color-token-dropdown-background,rgb(38,38,38));box-shadow:0 8px 24px rgba(0,0,0,.28);color:var(--color-token-text-primary,#fff);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:18px;white-space:normal;opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity .1s ease,transform .1s ease,visibility .1s;pointer-events:none}
        .tooltip.open{opacity:1;visibility:visible;transform:translateY(0)}
        @media (prefers-reduced-motion:reduce){.tooltip{transition:none}}
      </style><div id="popover" class="popover" role="dialog" aria-label="完整额度">
        <div class="popover-head"><span class="popover-head-title">额度</span><svg class="popover-head-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.22-6.49L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 15.22 6.49L21 16"></path><path d="M16 16h5v5"></path></svg></div>
        <div id="popover-grid" class="popover-grid"></div><button id="open-hub" class="hub-open" type="button">打开 Balance Hub</button>
      </div><div id="tooltip" class="tooltip" role="tooltip"></div>`;
      shadow.getElementById('open-hub').addEventListener('click', () => openHub());
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

  function positionPopover() {
    if (!state.popoverOpen || !state.popoverShadow) return;
    const anchor = state.popoverAnchor?.root?.isConnected
      ? state.popoverAnchor
      : { root: state.root, shadow: state.shadow };
    const button = anchor.root?.__codexUsageRefreshButton;
    const popover = state.popoverShadow.querySelector('.popover');
    if (!button || !popover) return;
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - popoverRect.width - 8, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.bottom = `${Math.round(window.innerHeight - buttonRect.top + 10)}px`;
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

  function publishPageAction(action) {
    state.actionToken += 1;
    const value = `${action}|${state.actionToken}|${Date.now()}`;
    const bytes = new TextEncoder().encode(value);
    let marker = '';
    for (const byte of bytes) {
      marker += byte.toString(2).padStart(8, '0').replaceAll('0', '\u200b').replaceAll('1', '\u200c');
    }
    const markerIndex = document.title.lastIndexOf(pageActionSentinel);
    const baseTitle = markerIndex < 0 ? document.title : document.title.slice(0, markerIndex);
    document.title = `${baseTitle}${pageActionSentinel}${marker}`;
  }

  function openHub() {
    hideUsageTooltip();
    state.popoverOpen = false;
    state.popoverShadow?.querySelector('.popover')?.classList.remove('open');
    publishPageAction('open-hub');
  }

  function bindUsageEvents(instance, usage, refreshButton) {
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
      state.refreshToken += 1;
      state.refreshRequestedAt = Date.now();
      publishPageAction('refresh');
      state.loading = true;
      state.popoverAnchor = instance;
      const shouldScheduleLayout = instance.root.dataset.mode === 'icon';
      if (shouldScheduleLayout) state.popoverOpen = !state.popoverOpen;
      render(null, shouldScheduleLayout);
    });
    usage.addEventListener('click', event => {
      if (event.target?.closest?.('.refresh')) return;
      event.preventDefault();
      event.stopPropagation();
      openHub();
    });
    usage.addEventListener('keydown', event => {
      if (event.target !== usage || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openHub();
    });
  }

  function ensureUsageElement(instance) {
    let usage = instance.root.__codexUsageElement;
    if (usage && usage.getRootNode() !== instance.shadow) usage = null;
    if (!usage) usage = instance.shadow.querySelector('.usage');
    if (usage) {
      if (!usage.__codexUsageRefreshButton) usage.__codexUsageRefreshButton = usage.querySelector('.refresh');
      instance.root.__codexUsageElement = usage;
      instance.root.__codexUsageRefreshButton = usage.__codexUsageRefreshButton;
      return usage;
    }
    usage = document.createElement('div');
    usage.className = 'usage';
    usage.tabIndex = 0;
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.setAttribute('aria-hidden', 'true');
    const refreshButton = document.createElement('button');
    refreshButton.className = 'refresh';
    refreshButton.type = 'button';
    refreshButton.setAttribute('aria-label', '刷新 CCSwitch 用量');
    refreshButton.appendChild(createRefreshIcon());
    usage.append(dot, refreshButton);
    usage.__codexUsageRefreshButton = refreshButton;
    instance.root.__codexUsageElement = usage;
    instance.root.__codexUsageRefreshButton = refreshButton;
    instance.shadow.getElementById('content').replaceChildren(usage);
    bindUsageEvents(instance, usage, refreshButton);
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
    updateElementAttribute(refreshButton, 'data-loading', state.loading ? 'true' : null);
    if (instance.root.__codexUsagePayload === payload) return;
    instance.root.__codexUsageMeasurements = null;
    for (const child of [...usage.children]) {
      if (child.dataset.usageDynamic === 'true') child.remove();
    }
    for (const element of buildUsageElements(payload, balanceLevel)) usage.insertBefore(element, refreshButton);
    instance.root.__codexUsagePayload = payload;
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
      view = { payload, balanceLevel, freshness: '', title: '' };
      state.__codexUsageView = view;
    }
    view.freshness = getUsageFreshness(payload);
    view.title = usageTitle(payload);

    syncMirrors(footers);
    renderInstance({ footer: state.footer, root: state.root, shadow: state.shadow }, payload, view.balanceLevel);
    for (const mirror of state.mirrors) renderInstance(mirror, payload, view.balanceLevel);
    const portal = state.popoverShadow || (state.popoverOpen ? ensurePopoverPortal() : null);
    if (portal) {
      portal.getElementById('popover').classList.toggle('open', state.popoverOpen);
      renderPopoverRows(portal, payload);
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
    return right.firstElementChild?.firstElementChild || right;
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
    if (!isNativeFlowCacheValid(flow, root, right)) {
      const toolbar = findRightToolbar(right);
      const toolbarParent = toolbar?.parentElement;
      const lane = toolbarParent && right.contains(toolbarParent) && getComputedStyle(toolbarParent).display === 'flex'
        ? toolbarParent
        : right;
      const candidateBefore = lane === toolbarParent ? toolbar : lane.firstElementChild;
      const before = candidateBefore === root ? root.nextElementSibling : candidateBefore;
      flow = { right, lane, before };
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
    if (mode !== 'icon' && state.popoverOpen && state.popoverAnchor?.root === root) {
      state.popoverOpen = false;
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
      const collapsed = entries.some(entry => (
        (entry.target === state.footer || entry.target === state.root || state.mirrors.some(mirror => entry.target === mirror.footer || entry.target === mirror.root))
        && (entry.contentRect.width <= 0 || entry.contentRect.height <= 0)
      ));
      if (collapsed) {
        const recovered = recoverComposerNow();
        if (recovered) scheduleLayout();
        return;
      }
      if (!rootChanged) return;
      if (roots.some(rootResizeNeedsLayout)) scheduleLayout();
    });
    state.resizeObservedElements = uniqueElements;
    seedRootResizeSizes(roots);
    for (const element of uniqueElements) state.resizeObserver.observe(element);
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
    if (!footer || !parts) return false;
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
    state.payload = payload;
    state.loading = false;
    mount();
    return true;
  };
  state.mount = mount;
  state.getRefreshToken = () => state.refreshToken;
  state.getRefreshRequest = () => ({ token: state.refreshToken, requestedAt: state.refreshRequestedAt });
  state.setPopoverOpen = open => {
    state.popoverOpen = Boolean(open);
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
    state.popoverOpen = false;
    render();
  }, { capture: true, signal: state.eventController.signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !state.popoverOpen) return;
    state.popoverOpen = false;
    render();
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
  mount();
  return true;
}

export function buildInjectorScript() {
  return `(${installCodexUsageExtension.toString()})(${findUsageTooltipTarget.toString()},${isUsageTooltipBoundaryCrossing.toString()},${getUsageFreshness.toString()},${formatUsageAge.toString()},${selectResponsiveUsageMode.toString()},${calculateResponsiveMeasurements.toString()},${stabilizeResponsiveUsageMode.toString()},${findMutationObserverTarget.toString()},${classifyComposerMutations.toString()},${createInjectorEventController.toString()},${updateElementAttribute.toString()},${isNativeFlowCacheValid.toString()},${JSON.stringify(PAGE_ACTION_SENTINEL)},${INJECTOR_VERSION})`;
}

export const UPDATE_GLOBAL = '__CODEX_CCSWITCH_USAGE__';
