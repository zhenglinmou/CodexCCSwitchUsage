import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildInjectorScript,
  calculateExpandedNativeTriggerMaxWidth,
  calculatePopoverPlacement,
  calculateResponsiveMeasurements,
  classifyComposerMutations,
  createInjectorEventController,
  findMutationObserverTarget,
  findUsageTooltipTarget,
  getUsageFreshness,
  INJECTOR_VERSION,
  isComposerFooterCandidate,
  isNativeFlowCacheValid,
  isUsageTooltipBoundaryCrossing,
  mutationNeedsComposerSync,
  PAGE_ACTION_SENTINEL,
  resolveNativeFlowPlacement,
  selectResponsiveUsageMode,
  stabilizeResponsiveUsageMode,
  updateElementAttribute,
} from '../src/injector-script.mjs';

function target(matches = {}) {
  return {
    closest(selector) {
      return matches[selector] || null;
    },
  };
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('injector script carries an exported version for hot replacement', () => {
  assert.equal(Number.isInteger(INJECTOR_VERSION), true);
  assert.ok(INJECTOR_VERSION >= 91);
  assert.match(buildInjectorScript(), new RegExp(`,${INJECTOR_VERSION}\\)$`));
});

test('footer hides provider details while tooltip and popover retain them', () => {
  const script = buildInjectorScript();
  const title = sourceSection(script, 'function usageTitle(payload) {', 'function popoverRows(payload) {');
  const popover = sourceSection(script, 'function popoverRows(payload) {', 'function formatTokenCount(');
  const footer = sourceSection(script, 'function buildUsageElements(payload, balanceLevel) {', 'function renderInstance(');

  assert.doesNotMatch(footer, /payload\.extra|metric extra/);
  assert.match(title, /if \(payload\.extra\) values\.push\(payload\.extra\)/);
  assert.match(popover, /if \(payload\.extra\)/);
});

test('popover placement stays inside the viewport above or below a top-edge trigger', () => {
  const below = calculatePopoverPlacement({ top: 4, bottom: 28 }, 600, 240);
  assert.deepEqual(below, { placement: 'below', maxHeight: 560, top: 32, bottom: null });
  assert.ok(below.top + below.maxHeight <= 592);

  const above = calculatePopoverPlacement({ top: 560, bottom: 584 }, 600, 240);
  assert.deepEqual(above, { placement: 'above', maxHeight: 548, top: null, bottom: 44 });
  assert.ok(600 - above.bottom - Math.min(240, above.maxHeight) >= 8);

  const constrained = calculatePopoverPlacement({ top: 90, bottom: 114 }, 180, 240);
  assert.equal(constrained.maxHeight, 78);
  assert.equal(constrained.placement, 'above');
  const script = buildInjectorScript();
  assert.match(script, /flex-direction:column;overflow:hidden/);
  assert.match(script, /\.popover-grid\{display:grid;flex:1 1 auto;min-height:0;[\s\S]*overflow-y:auto/);
});

test('custom popovers reuse the native menu surface and action-row styling', () => {
  const script = buildInjectorScript();
  const popoverStyles = sourceSection(script, '.popover{', '.tooltip{');

  assert.match(popoverStyles, /padding:4px;border:0;border-radius:15px/);
  assert.match(popoverStyles, /background:color-mix\(in srgb,var\(--color-token-dropdown-background,rgb\(38,38,38\)\) 90%,transparent\)/);
  assert.match(popoverStyles, /box-shadow:0 0 0 \.5px [^;]+,0 8px 16px -4px rgba\(0,0,0,\.12\)/);
  assert.match(popoverStyles, /backdrop-filter:blur\(8px\)/);
  assert.doesNotMatch(popoverStyles, /transform:translateY|transition:/);
  assert.match(popoverStyles, /\.popover-head\{[^}]*margin:4px 8px 0/);
  assert.match(popoverStyles, /\.hub-open\{[^}]*height:28px;[^}]*padding:4px 8px;border:0;border-radius:\.75rem;background:transparent/);
  assert.match(popoverStyles, /\.hub-open:hover,\.hub-open:focus-visible\{background:var\(--color-token-list-hover-background/);
});

test('every programmatic popover close synchronizes trigger and dialog ARIA state', () => {
  const script = buildInjectorScript();
  const visibility = sourceSection(script, 'function syncPopoverVisibility() {', 'function closePopover(');
  const openHub = sourceSection(script, 'function openHub() {', 'function toggleRequestPopover(');
  const responsive = sourceSection(script, 'function layoutRoot(footer, root) {', 'function layout() {');

  assert.match(visibility, /aria-expanded/);
  assert.match(visibility, /aria-hidden/);
  assert.match(openHub, /closePopover\(false\)/);
  assert.match(responsive, /closePopover\(false, false\)/);
  assert.doesNotMatch(responsive, /state\.popoverOpen = false/);
});

test('composer footer detection accepts the embedded-editor grid and rejects its wrapper', () => {
  const editor = {};
  const actionPart = {
    contains: () => false,
    querySelector: () => ({}),
  };
  const editorPart = {
    contains: node => node === editor,
    querySelector: () => null,
  };
  const decorativePart = {
    contains: () => false,
    querySelector: () => null,
  };
  const embeddedFooter = { children: [actionPart, editorPart, actionPart] };
  const outerWrapper = {
    children: [
      decorativePart,
      { contains: node => node === editor, querySelector: () => ({}) },
      decorativePart,
    ],
  };
  const currentFooterRect = { width: 736, height: 76, top: 920 };
  const currentEditorRect = { bottom: 964 };

  assert.equal(
    isComposerFooterCandidate(embeddedFooter, editor, currentFooterRect, currentEditorRect),
    true,
  );
  assert.equal(
    isComposerFooterCandidate(outerWrapper, editor, { width: 736, height: 98, top: 906 }, currentEditorRect),
    false,
  );
  assert.equal(
    isComposerFooterCandidate(
      { children: [decorativePart, decorativePart, actionPart] },
      editor,
      { width: 736, height: 28, top: 968 },
      currentEditorRect,
    ),
    true,
  );
});

test('composer discovery supports the Codex 26.730 responsive layout attributes', () => {
  const script = buildInjectorScript();
  const discovery = sourceSection(
    script,
    'function findComposerFooter(surface, editor) {',
    'const usageStyles = `',
  );

  assert.match(discovery, /\[contenteditable="true"\]\[data-codex-composer="true"\]/);
  assert.match(discovery, /\[data-composer-surface-variant\]/);
  assert.match(discovery, /\[data-composer-footer-responsive\]/);
  assert.match(discovery, /hasAttribute\('data-composer-footer-responsive'\)/);
});

test('injector caches hot-path usage and toolbar DOM references on each root', () => {
  const source = fs.readFileSync(new URL('../src/injector-script.mjs', import.meta.url), 'utf8');

  assert.match(source, /root\.__codexUsageElement/);
  assert.match(source, /root\.__codexUsageHubButton/);
  assert.match(source, /root\.__codexUsageRefreshButton/);
  assert.match(source, /const usage = root\.__codexUsageElement/);
  assert.match(source, /const refresh = root\.__codexUsageRefreshButton/);
});

test('only the remaining numeric value uses the blended purple-pink emphasis', () => {
  const source = fs.readFileSync(new URL('../src/injector-script.mjs', import.meta.url), 'utf8');

  assert.match(source, /\.remaining-value\{color:#c77dff;font-weight:600\}/);
  assert.match(source, /dynamicElement\('span', 'metric remaining'\)/);
  assert.match(source, /createTextNode\(periodLabel \? '剩 ' : '剩余 '\)/);
  assert.match(source, /remainingValue\.className = 'remaining-value'/);
  assert.match(source, /remainingValue\.textContent = remaining/);
  assert.match(source, /createTextNode\(` \$\{unit\}`\)/);
});

test('hot replacement aborts the previous global event listeners before creating new ones', () => {
  let abortCalls = 0;
  const existing = { eventController: { abort: () => { abortCalls += 1; } } };
  class FakeAbortController {
    constructor() {
      this.signal = { name: 'new-signal' };
    }
  }

  const controller = createInjectorEventController(existing, FakeAbortController);

  assert.equal(abortCalls, 1);
  assert.equal(controller instanceof FakeAbortController, true);
  assert.deepEqual(controller.signal, { name: 'new-signal' });
});

test('hot replacement clears a pending tooltip delay', () => {
  const script = buildInjectorScript();
  const teardown = sourceSection(script, 'if (existing) {', 'const state = {');

  assert.match(teardown, /if \(existing\.tooltipTimer\) clearTimeout\(existing\.tooltipTimer\)/);
});

test('refresh button publishes an invisible title action without a Runtime binding', () => {
  const script = buildInjectorScript();
  assert.match(script, new RegExp(PAGE_ACTION_SENTINEL));
  assert.match(script, /publishPageAction\('refresh'/);
  assert.doesNotMatch(script, /window\[refreshBinding\]|Runtime\.addBinding/);
});

test('icon popover exposes a refresh button that refreshes without closing the panel', () => {
  const script = buildInjectorScript();
  const portalSource = sourceSection(script, 'function ensurePopoverPortal() {', 'function usageTitle(');

  assert.match(portalSource, /<button id="popover-refresh" class="popover-refresh" type="button" aria-label="刷新 CCSwitch 用量">/);
  assert.match(portalSource, /getElementById\('popover-refresh'\)\.addEventListener\('click', event => \{/);
  assert.match(portalSource, /requestRefresh\(state\.popoverAnchor, false\)/);
  assert.match(script, /updateElementAttribute\(popoverRefreshButton, 'data-loading', popoverLoading \? 'true' : null\)/);
});

test('the grid control opens recent requests while only the popover footer publishes the Hub action', () => {
  const script = buildInjectorScript();
  const eventSource = sourceSection(script, 'function bindUsageEvents(instance, usage, hubButton, refreshButton) {', 'function ensureUsageElement(instance) {');
  const portalSource = sourceSection(script, 'function ensurePopoverPortal() {', 'function usageTitle(');
  assert.match(script, /publishPageAction\('open-hub'/);
  assert.doesNotMatch(script, /window\[hubBinding\]|Runtime\.addBinding/);
  assert.match(script, /id="open-hub"/);
  assert.match(script, /hubButton\.className = 'toolbar-action hub-trigger'/);
  assert.match(eventSource, /hubButton\.addEventListener\('click'/);
  assert.match(eventSource, /toggleRequestPopover\(instance\)/);
  assert.doesNotMatch(eventSource, /openHub\(\)|publishPageAction\('open-hub'/);
  assert.match(portalSource, /getElementById\('open-hub'\)\.addEventListener\('click', \(\) => openHub\(\)\)/);
  assert.doesNotMatch(eventSource, /usage\.addEventListener\('click'/);
  assert.doesNotMatch(eventSource, /usage\.addEventListener\('keydown'/);
  assert.match(script, /打开 All API Hub/);
});

test('recent request popover renders at most ten current-provider rows with model and token usage', () => {
  const script = buildInjectorScript();
  const renderer = sourceSection(script, 'function renderRecentRequests(portal, payload) {', 'function render(footers = null');

  assert.match(script, /id="recent-requests" class="request-list" role="list"/);
  assert.match(script, /\.popover\[data-mode="requests"\]\{width:min\(420px,calc\(100vw - 16px\)\)\}/);
  assert.match(renderer, /payload\.recentRequests\.slice\(0, 10\)/);
  assert.match(renderer, /const ageMinute = Math\.floor\(Date\.now\(\) \/ 60_000\)/);
  assert.match(renderer, /state\.recentRequestsPayload === payload && state\.recentRequestsAgeMinute === ageMinute/);
  assert.match(renderer, /item\.model \|\| item\.requestModel \|\| '未知模型'/);
  assert.match(renderer, /requestMetadata\(item\)/);
  assert.match(script, /`输入 \$\{formatTokenCount\(item\.inputTokens\)\}`/);
  assert.match(script, /`输出 \$\{formatTokenCount\(item\.outputTokens\)\}`/);
  assert.match(script, /formatRequestCost\(item\.totalCost \?\? item\.totalCostUsd, item\.costUnit \|\| 'USD'\)/);
  assert.match(script, /当前供应商还没有 Codex 请求记录/);
});

test('closing recent requests preserves the outgoing mode throughout the exit transition', () => {
  const script = buildInjectorScript();
  const renderer = sourceSection(script, 'function render(footers = null, shouldScheduleLayout = true) {', 'function findRightToolbar(');

  assert.match(
    renderer,
    /const popoverMode = state\.popoverOpen\s+\? \(state\.popoverMode \|\| 'balance'\)\s+: \(popover\.getAttribute\('data-mode'\) \|\| 'balance'\);/,
    'a closing request panel must not switch to the default balance mode before its fade-out finishes',
  );
});

test('Hub control shares refresh styling and stays inside the responsive content group', () => {
  const source = fs.readFileSync(new URL('../src/injector-script.mjs', import.meta.url), 'utf8');

  assert.match(source, /\.toolbar-action\{[^}]*width:28px[^}]*height:28px/);
  assert.match(source, /\.toolbar-action:hover\{background:var\(--color-token-list-hover-background/);
  assert.match(source, /refreshButton\.className = 'toolbar-action refresh'/);
  assert.match(source, /usage\.append\(dot, hubButton, refreshButton\)/);
  assert.match(source, /usage\.insertBefore\(element, hubButton\)/);
  assert.match(source, /:host\(\[data-mode="icon"\]\)[^{]*\.hub-trigger\{display:none\}/);
});

test('usage tooltips match the native Codex tooltip surface and spacing', () => {
  const script = buildInjectorScript();
  const portalSource = sourceSection(script, 'function ensurePopoverPortal() {', 'function usageTitle(');
  const tooltipSource = sourceSection(script, 'function showUsageTooltip(instance, text, anchorElement = null) {', 'function syncMirrors(');

  assert.match(portalSource, /\.tooltip\{[^}]*width:fit-content[^}]*max-width:min\(20rem,calc\(100vw - 16px\)\)/);
  assert.match(portalSource, /\.tooltip\{[^}]*padding:4px 8px[^}]*border:1px solid var\(--color-token-border,rgba\(127,127,127,\.08\)\)[^}]*border-radius:\.75rem/);
  assert.match(portalSource, /\.tooltip\{[^}]*box-shadow:none[^}]*font-size:var\(--text-sm,13px\)[^}]*font-weight:445/);
  assert.doesNotMatch(portalSource, /\.tooltip\{[^}]*translateY|\.tooltip\{[^}]*box-shadow:0/);
  assert.match(tooltipSource, /innerHeight - anchorRect\.top \+ 4/);
});

test('refresh loading animation follows the counter-clockwise arrow direction', () => {
  const source = fs.readFileSync(new URL('../src/injector-script.mjs', import.meta.url), 'utf8');

  assert.match(source, /@keyframes codex-usage-spin\{to\{transform:rotate\(-360deg\)\}\}/);
  assert.doesNotMatch(source, /@keyframes codex-usage-spin\{to\{transform:rotate\(360deg\)\}\}/);
});

test('hot payload rendering does not replace usage or popover innerHTML', () => {
  const script = buildInjectorScript();
  assert.doesNotMatch(script, /getElementById\('content'\)\.innerHTML\s*=/);
  assert.doesNotMatch(script, /popover\.innerHTML\s*=/);
});

test('injector reuses number formatting and reduced-motion query objects', () => {
  const script = buildInjectorScript();
  assert.equal((script.match(/new Intl\.NumberFormat/g) || []).length, 1);
  assert.doesNotMatch(script, /\.toLocaleString\(/);
  assert.equal((script.match(/matchMedia\(/g) || []).length, 1);
  assert.match(script, /reducedMotionQuery/);
});

test('primary and mirror layouts share one ResizeObserver', () => {
  const script = buildInjectorScript();
  assert.equal((script.match(/new ResizeObserver/g) || []).length, 1);
});

test('usage shadows share a stylesheet and keep a style-element fallback', () => {
  const script = buildInjectorScript();
  assert.match(script, /adoptedStyleSheets/);
  assert.match(script, /createElement\('style'\)/);
  assert.equal((script.match(/\.popover\{/g) || []).length, 1, 'popover CSS should only exist in the portal stylesheet');
});

test('mutation observer follows a stable ancestor that survives main replacement', () => {
  const body = { name: 'body' };
  const mainParent = { name: 'main-parent' };
  const main = { name: 'main', parentElement: mainParent };
  const composerParent = { name: 'composer-parent' };
  const documentNode = { body, querySelector: () => main };
  const bodyOnlyDocumentNode = { body, querySelector: () => null };
  const footerInMain = {
    parentElement: { name: 'footer-parent' },
    closest(selector) {
      if (selector.startsWith('main')) return main;
      return null;
    },
  };
  const footerInComposer = {
    parentElement: { name: 'footer-parent' },
    closest(selector) {
      if (selector.includes('composer-surface')) return { parentElement: composerParent };
      return null;
    },
  };

  assert.equal(findMutationObserverTarget(footerInMain, documentNode), mainParent);
  assert.equal(findMutationObserverTarget(footerInComposer, documentNode), composerParent);
  assert.equal(findMutationObserverTarget(null, documentNode), mainParent);
  assert.equal(findMutationObserverTarget(null, bodyOnlyDocumentNode), body);
});

test('initial mount waits for lifecycle events without retry polling', () => {
  const script = buildInjectorScript();
  const startup = sourceSection(script, 'window[GLOBAL] = state;', 'return true;\n}');

  assert.match(startup, /mount\(\);/);
  assert.doesNotMatch(script, /function scheduleMountRecovery|const mountRetryDelays/);
});

test('injector coordinates theme, navigation, visibility and activation recovery', () => {
  const source = fs.readFileSync(new URL('../src/injector-script.mjs', import.meta.url), 'utf8');
  const activation = sourceSection(source, 'function recoverOnActivation()', 'state.update = payload =>');

  assert.match(source, /state\.themeObserver = new MutationObserver/);
  assert.match(source, /attributeFilter: \['class', 'style'\]/);
  assert.doesNotMatch(source, /function scheduleMountRecovery|const mountRetryDelays/);
  assert.match(source, /window\.addEventListener\('pageshow', recoverOnActivation/);
  assert.match(source, /window\.addEventListener\('focus', recoverOnActivation/);
  assert.match(source, /window\.addEventListener\('popstate'/);
  assert.match(source, /window\.navigation\?\.addEventListener\?\.\('navigatesuccess'/);
  assert.match(source, /document\.addEventListener\('visibilitychange'/);
  assert.doesNotMatch(source, /document\.addEventListener\('click'/);
  assert.match(source, /new ResizeObserver\(entries =>/);
  assert.match(activation, /scheduleComposerSync\(\)/);
  assert.doesNotMatch(activation, /scheduleLayout\(\)/);
  assert.doesNotMatch(activation, /invalidateResponsiveMeasurements\(\)/);
});

test('mutation classifier mounts only for composer lifecycle changes', () => {
  const footer = { isConnected: true, contains: () => false };
  const root = { nodeType: 1, isConnected: true, contains: () => false, matches: () => false, querySelector: () => null };
  const textNode = { nodeType: 3 };
  const unrelatedElement = { nodeType: 1, contains: () => false, matches: () => false, querySelector: () => null };
  const editorElement = { nodeType: 1, contains: () => false, matches: selector => selector.includes('contenteditable'), querySelector: () => null };
  const footerChild = {};
  const footerWithChildren = { isConnected: true, contains: node => node === footerChild };
  const detachedRoot = { ...root, isConnected: false };
  const stableRemovedLeaf = {
    nodeType: 1,
    childElementCount: 0,
    contains: () => { throw new Error('stable mounts must skip detached-root containment checks'); },
    matches: () => false,
    querySelector: () => { throw new Error('leaf mutations must not scan descendants'); },
  };

  assert.equal(classifyComposerMutations([{ addedNodes: [textNode, unrelatedElement], removedNodes: [] }], footer, root), 'ignore');
  assert.equal(classifyComposerMutations([{ addedNodes: [editorElement], removedNodes: [] }], footer, root), 'mount');
  assert.equal(classifyComposerMutations([{ target: footerChild, addedNodes: [unrelatedElement], removedNodes: [] }], footerWithChildren, root), 'ignore');
  assert.equal(classifyComposerMutations([{ addedNodes: [unrelatedElement], removedNodes: [] }], footer, detachedRoot), 'ignore');
  assert.equal(classifyComposerMutations([{ addedNodes: [], removedNodes: [detachedRoot] }], footer, detachedRoot), 'mount');
  assert.equal(classifyComposerMutations([{ addedNodes: [], removedNodes: [stableRemovedLeaf] }], footer, root), 'ignore');
  assert.equal(mutationNeedsComposerSync([{ addedNodes: [textNode, unrelatedElement], removedNodes: [] }], footer, root), false);
  assert.equal(mutationNeedsComposerSync([{ addedNodes: [editorElement], removedNodes: [] }], footer, root), true);
  assert.equal(mutationNeedsComposerSync([{ target: footerChild, addedNodes: [unrelatedElement], removedNodes: [] }], footerWithChildren, root), false);
});

test('every composer lifecycle mutation synchronizes immediately', () => {
  const script = buildInjectorScript();
  const observer = sourceSection(
    script,
    'state.observer = new MutationObserver(records => {',
    'observeRelevantMutations();',
  );

  assert.match(observer, /const mutationAction = classifyComposerMutations\(records, state\.footer, state\.root\);/);
  assert.match(observer, /if \(mutationAction === 'mount'\) recoverComposerNow\(\);/);
  assert.doesNotMatch(observer, /scheduleLayout\(\)/);
  assert.ok(
    observer.indexOf('recoverComposerNow()') < observer.indexOf('});'),
    'composer lifecycle records must enter the immediate recovery path',
  );
});

test('a collapsed observed composer enters immediate recovery', () => {
  const script = buildInjectorScript();
  const resizeObserver = sourceSection(
    script,
    'if (!state.resizeObserver) state.resizeObserver = new ResizeObserver(entries => {',
    'state.resizeObservedElements = uniqueElements;',
  );

  assert.match(resizeObserver, /if \(collapsed\) \{[\s\S]*const recovered = recoverComposerNow\(\);[\s\S]*if \(recovered\) scheduleLayout\(\);[\s\S]*return;[\s\S]*\}/);
  assert.ok(
    resizeObserver.indexOf('recoverComposerNow()') < resizeObserver.indexOf('scheduleLayout()'),
    'recovery must run before the next layout frame is requested',
  );
});

test('root resize schedules layout only for a responsive-mode or native-flow change', () => {
  const script = buildInjectorScript();
  const resizeHelpers = sourceSection(
    script,
    'function rootResizeNeedsLayout(root) {',
    'function syncResizeObservation() {',
  );
  const resizeObserver = sourceSection(
    script,
    'if (!state.resizeObserver) state.resizeObserver = new ResizeObserver(entries => {',
    'state.resizeObservedElements = uniqueElements;',
  );

  assert.match(resizeHelpers, /const cached = root\.__codexUsageMeasurements;/);
  assert.match(resizeHelpers, /const width = root\.clientWidth;/);
  assert.match(resizeHelpers, /fits: spare >= -0\.5/);
  assert.match(resizeHelpers, /const selected = selectResponsiveUsageMode\(measurements, previousMode\);/);
  assert.match(resizeHelpers, /return selected !== previousMode;/);
  assert.match(resizeObserver, /const rootChanged = hasMeaningfulRootResize\(entries, roots\);/);
  assert.match(resizeObserver, /const nativeFlowChanged = roots\.some\(root => \{/);
  assert.match(resizeObserver, /if \(!rootChanged && !nativeFlowChanged\) return;/);
  assert.match(resizeObserver, /if \(nativeFlowChanged \|\| roots\.some\(rootResizeNeedsLayout\)\) scheduleLayout\(\);/);
  assert.doesNotMatch(resizeObserver, /scheduleRootResizeBurst/);
});

test('initial root observation is seeded and subpixel changes do not start a resize burst', () => {
  const script = buildInjectorScript();
  const resizeHelpers = sourceSection(
    script,
    'function seedRootResizeSizes(roots) {',
    'function rootResizeNeedsLayout(root) {',
  );
  const resizeSync = sourceSection(
    script,
    'function syncResizeObservation() {',
    'function mount(forceScan = false) {',
  );

  assert.match(script, /rootResizeSizes: new WeakMap\(\)/);
  assert.match(resizeHelpers, /state\.rootResizeSizes\.set\(root, \{ width: rect\.width, height: rect\.height \}\)/);
  assert.match(resizeHelpers, /Math\.abs\(next\.width - previous\.width\) > 0\.5/);
  assert.match(resizeHelpers, /Math\.abs\(next\.height - previous\.height\) > 0\.5/);
  assert.match(resizeSync, /seedRootResizeSizes\(roots\);\s+for \(const element of uniqueElements\) state\.resizeObserver\.observe\(element\);/);
});

test('mutation observer filter handles DOM node lists without iterator expansion', () => {
  const footer = { isConnected: true };
  const root = { isConnected: true };
  const unrelatedElement = { nodeType: 1, matches: () => false, querySelector: () => null };
  const editorElement = { nodeType: 1, matches: selector => selector.includes('contenteditable'), querySelector: () => null };
  const nodeList = node => ({
    0: node,
    length: 1,
    get [Symbol.iterator]() {
      throw new Error('hot-path filter must not expand DOM NodeLists');
    },
  });
  const emptyNodeList = { length: 0 };

  assert.equal(mutationNeedsComposerSync([{ addedNodes: nodeList(unrelatedElement), removedNodes: emptyNodeList }], footer, root), false);
  assert.equal(mutationNeedsComposerSync([{ addedNodes: emptyNodeList, removedNodes: nodeList(editorElement) }], footer, root), true);
});

test('injector scans footers only once during a forced mount', () => {
  const occurrences = buildInjectorScript().match(/findFooters\(\)/g) || [];
  assert.equal(occurrences.length, 2, 'one function declaration plus one call is expected');
});

test('steady pages install no global click recovery handler', () => {
  const script = buildInjectorScript();

  assert.doesNotMatch(script, /document\.addEventListener\('click'/);
});

test('balance tooltip only targets usage text', () => {
  const metric = { className: 'metric' };
  const meter = { className: 'meter' };
  const message = { className: 'message' };

  assert.equal(findUsageTooltipTarget(target({ '.metric,.meter,.message': metric })), metric);
  assert.equal(findUsageTooltipTarget(target({ '.metric,.meter,.message': meter })), meter);
  assert.equal(findUsageTooltipTarget(target({ '.metric,.meter,.message': message })), message);
  assert.equal(findUsageTooltipTarget(target()), null, 'blank usage area must not trigger the balance tooltip');
  assert.equal(findUsageTooltipTarget(target({ '.refresh,.hub-trigger,.hub-open': {} })), null, 'toolbar buttons must not trigger the balance tooltip');
});

test('moving inside the usage content group does not cross its hover boundary', () => {
  const metric = target({ '.metric,.meter,.message': { className: 'metric' } });
  const meter = target({ '.metric,.meter,.message': { className: 'meter' } });
  const blank = target();

  assert.equal(isUsageTooltipBoundaryCrossing(metric, blank), true);
  assert.equal(isUsageTooltipBoundaryCrossing(meter, metric), false);
  assert.equal(isUsageTooltipBoundaryCrossing(metric, meter), false);
  assert.equal(isUsageTooltipBoundaryCrossing(metric, blank), true);
});

test('usage freshness reflects failures and elapsed refresh intervals', () => {
  const now = Date.parse('2026-07-12T08:00:00.000Z');
  const payload = {
    status: 'ok',
    updatedAt: '2026-07-12T07:55:00.000Z',
    refreshIntervalMinutes: 5,
  };

  assert.equal(getUsageFreshness(payload, now), 'fresh');
  assert.equal(getUsageFreshness({ ...payload, queryError: 'timeout' }, now), 'degraded');
  assert.equal(getUsageFreshness({ ...payload, updatedAt: '2026-07-12T07:45:00.000Z' }, now), 'stale');
  assert.equal(getUsageFreshness({ ...payload, updatedAt: '2026-07-12T07:20:00.000Z' }, now), 'expired');
  assert.equal(getUsageFreshness({ ...payload, updatedAt: '2026-07-12T07:20:00.000Z', queryError: 'timeout' }, now), 'expired');
});

test('responsive layout hides fields by priority and uses hysteresis when expanding', () => {
  const constrained = {
    full: { fits: false, spare: -40 },
    compact: { fits: false, spare: -20 },
    'no-extra': { fits: false, spare: -8 },
    'no-used': { fits: true, spare: 3 },
    'no-meter': { fits: true, spare: 28 },
    'no-dot': { fits: true, spare: 40 },
    icon: { fits: true, spare: 0 },
  };
  assert.equal(selectResponsiveUsageMode(constrained, 'full'), 'no-used');

  const barelyExpanded = { ...constrained, 'no-extra': { fits: true, spare: 5 } };
  assert.equal(selectResponsiveUsageMode(barelyExpanded, 'no-used'), 'no-used');

  const comfortablyExpanded = { ...constrained, 'no-extra': { fits: true, spare: 14 } };
  assert.equal(selectResponsiveUsageMode(comfortablyExpanded, 'no-used'), 'no-extra');
});

test('continuous shrinking never restores fields that were already hidden', () => {
  const steps = [
    { width: 583, selected: 'no-used', expected: 'no-used' },
    { width: 516, selected: 'no-meter', expected: 'no-meter' },
    { width: 490, selected: 'no-used', expected: 'no-meter' },
    { width: 463, selected: 'no-meter', expected: 'no-meter' },
  ];
  let previousMode = 'full';
  let previousWidth = 736;
  let direction = '';

  for (const step of steps) {
    const stabilized = stabilizeResponsiveUsageMode(
      step.selected,
      previousMode,
      step.width,
      previousWidth,
      direction,
    );
    assert.equal(stabilized.mode, step.expected);
    previousMode = stabilized.mode;
    previousWidth = step.width;
    direction = stabilized.direction;
  }

  assert.equal(
    stabilizeResponsiveUsageMode('no-used', 'no-meter', 463, 463, 'settled').mode,
    'no-used',
    'settled layout may restore the most detailed mode that fits',
  );
});

test('continuous expanding never hides fields that were already restored', () => {
  const steps = [
    { width: 463, selected: 'no-meter', expected: 'no-meter' },
    { width: 481, selected: 'no-used', expected: 'no-used' },
    { width: 493, selected: 'no-meter', expected: 'no-used' },
    { width: 532, selected: 'no-used', expected: 'no-used' },
    { width: 598, selected: 'full', expected: 'full' },
  ];
  let previousMode = 'no-meter';
  let previousWidth = 463;
  let direction = 'settled';

  for (const step of steps) {
    const stabilized = stabilizeResponsiveUsageMode(
      step.selected,
      previousMode,
      step.width,
      previousWidth,
      direction,
    );
    assert.equal(stabilized.mode, step.expected);
    previousMode = stabilized.mode;
    previousWidth = step.width;
    direction = stabilized.direction;
  }

  assert.equal(
    stabilizeResponsiveUsageMode('no-meter', 'no-used', 598, 598, 'settled').mode,
    'no-meter',
    'settled layout may fold back to the most detailed mode that actually fits',
  );
});

test('cached mode metrics become live responsive measurements with one geometry snapshot', () => {
  const measurements = calculateResponsiveMeasurements({
    full: { requiredWidth: 120, refreshRightOffset: 60 },
    icon: { requiredWidth: 28, refreshRightOffset: 14 },
  }, {
    rootLeft: 100,
    rootWidth: 100,
    clientWidth: 100,
    nativeLeft: 205,
  });

  assert.deepEqual(measurements.full, { fits: false, spare: -20 });
  assert.deepEqual(measurements.icon, { fits: true, spare: 72 });
});

test('expanded native model triggers yield to the squeezed toolbar without shrinking the balance lane below its icon', () => {
  assert.equal(calculateExpandedNativeTriggerMaxWidth({ laneWidth: 301, naturalWidth: 224, reservedWidth: 20 }), null);
  assert.equal(calculateExpandedNativeTriggerMaxWidth({ laneWidth: 261, naturalWidth: 224, reservedWidth: 20 }), 213);
  assert.equal(calculateExpandedNativeTriggerMaxWidth({ laneWidth: 221, naturalWidth: 224, reservedWidth: 20 }), 173);
  assert.equal(calculateExpandedNativeTriggerMaxWidth({ laneWidth: 181, naturalWidth: 224, reservedWidth: 20 }), 133);
  assert.equal(calculateExpandedNativeTriggerMaxWidth({ laneWidth: 141, naturalWidth: 224, reservedWidth: 20 }), 93);
  assert.equal(calculateExpandedNativeTriggerMaxWidth({ laneWidth: 101, naturalWidth: 33, reservedWidth: 20 }), null);
});

test('injector caches responsive mode measurements and invalidates them for font changes', () => {
  const script = buildInjectorScript();
  assert.match(script, /__codexUsageMeasurements/);
  assert.match(script, /calculateResponsiveMeasurements/);
  assert.match(script, /document\.fonts/);
});

test('render fast path only writes changed element attributes', () => {
  const attributes = new Map([['data-status', 'ok']]);
  let writes = 0;
  const element = {
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute(name, value) {
      writes += 1;
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      writes += 1;
      attributes.delete(name);
    },
  };

  assert.equal(updateElementAttribute(element, 'data-status', 'ok'), false);
  assert.equal(updateElementAttribute(element, 'data-status', 'error'), true);
  assert.equal(updateElementAttribute(element, 'data-status', null), true);
  assert.equal(writes, 2);
});

test('render coalesces geometry work through one animation frame', () => {
  const script = buildInjectorScript();
  const renderSource = sourceSection(script, 'function render(footers = null, shouldScheduleLayout = true) {', 'function findRightToolbar(');
  const schedulerSource = sourceSection(script, 'function scheduleLayout() {', 'function observeRelevantMutations() {');

  assert.match(renderSource, /scheduleLayout\(\);/);
  assert.doesNotMatch(renderSource, /\blayout\(\);/);
  assert.match(schedulerSource, /if \(state\.layoutFrame\) return;/);
  assert.match(schedulerSource, /state\.layoutFrame = requestAnimationFrame\(\(\) => \{/);
  assert.match(schedulerSource, /state\.layoutFrame = 0;\s+layout\(\);/);
});

test('refresh loading state skips geometry work unless icon mode toggles the popover', () => {
  const script = buildInjectorScript();
  const refreshHandler = sourceSection(
    script,
    'function requestRefresh(instance, togglePopover = false) {',
    'function ensureUsageElement(instance) {',
  );

  assert.match(refreshHandler, /if \(togglePopover\) \{[\s\S]*state\.popoverMode = state\.popoverOpen \? 'balance' : '';[\s\S]*\}/);
  assert.match(refreshHandler, /render\(null, togglePopover\);/);
  assert.match(refreshHandler, /requestRefresh\(instance, instance\.root\.dataset\.mode === 'icon'\);/);
  assert.doesNotMatch(refreshHandler, /\n\s*render\(\);/);
});

test('request-only payload updates skip balance DOM reconstruction and layout work', () => {
  const script = buildInjectorScript();
  const update = sourceSection(script, 'state.update = payload => {', 'state.mount = mount;');

  assert.match(script, /balancePayloadSignature/);
  assert.match(script, /__codexUsageContentSignature === view\.contentSignature/);
  assert.match(update, /const balanceChanged = balancePayloadSignature\(state\.payload\) !== balancePayloadSignature\(payload\)/);
  assert.match(update, /render\(null, balanceChanged\)/);
  assert.match(update, /if \(state\.popoverOpen && !balanceChanged\) positionPopover\(\)/);
});

test('toolbar flow cache is reused only while its DOM placement remains valid', () => {
  const right = {};
  const before = { isConnected: true };
  const laneParent = {};
  const lane = { isConnected: true, parentElement: laneParent };
  const root = { parentElement: lane, nextElementSibling: before };
  const styles = new Map([
    [lane, { display: 'flex', flexGrow: '1', flexShrink: '1' }],
    [laneParent, { display: 'flex', flexGrow: '0', flexShrink: '1' }],
  ]);
  const getStyle = element => styles.get(element) || { display: 'block', flexGrow: '0', flexShrink: '1' };
  const cache = { right, lane, before, signature: 'flex:1:1|flex:0:1' };

  assert.equal(isNativeFlowCacheValid(cache, root, right, getStyle), true);
  assert.equal(isNativeFlowCacheValid(cache, { ...root, nextElementSibling: null }, right, getStyle), false);
  assert.equal(isNativeFlowCacheValid({ ...cache, before: { isConnected: false } }, root, right, getStyle), false);
  styles.set(laneParent, { display: 'flex', flexGrow: '0', flexShrink: '0' });
  assert.equal(isNativeFlowCacheValid(cache, root, right, getStyle), false);
});

test('toolbar fallback preserves the Codex model lane and unwraps the ChatGPT contents layer', () => {
  const root = {};
  const modelGroup = {};
  const modelLane = {
    children: [modelGroup],
    firstElementChild: modelGroup,
  };
  const fixedActions = {};
  const outerToolbar = {
    children: [root, modelLane, fixedActions],
    firstElementChild: root,
  };
  const right = {
    children: [outerToolbar],
    firstElementChild: outerToolbar,
    contains: element => [outerToolbar, modelLane, modelGroup, fixedActions].includes(element),
  };
  modelGroup.parentElement = modelLane;
  root.nextElementSibling = modelLane;

  const styles = new Map([
    [right, { display: 'block', flexGrow: '0' }],
    [outerToolbar, { display: 'flex', flexGrow: '0' }],
    [modelLane, { display: 'flex', flexGrow: '1' }],
    [fixedActions, { display: 'flex', flexGrow: '0' }],
  ]);
  const getStyle = element => styles.get(element) || { display: 'block', flexGrow: '0' };

  assert.deepEqual(
    resolveNativeFlowPlacement(right, root, null, getStyle),
    { lane: modelLane, before: modelGroup },
  );
  assert.deepEqual(
    resolveNativeFlowPlacement(right, root, modelGroup, getStyle),
    { lane: modelLane, before: modelGroup },
  );

  const chatgptActions = {};
  const chatgptToolbar = {
    children: [chatgptActions],
    firstElementChild: chatgptActions,
  };
  const contents = {
    children: [chatgptToolbar],
    firstElementChild: chatgptToolbar,
  };
  const chatgptRight = {
    children: [contents],
    firstElementChild: contents,
    contains: element => [contents, chatgptToolbar, chatgptActions].includes(element),
  };
  styles.set(chatgptRight, { display: 'block', flexGrow: '0' });
  styles.set(contents, { display: 'contents', flexGrow: '0' });
  styles.set(chatgptToolbar, { display: 'flex', flexGrow: '0' });
  styles.set(chatgptActions, { display: 'flex', flexGrow: '0' });

  assert.deepEqual(
    resolveNativeFlowPlacement(chatgptRight, root, null, getStyle),
    { lane: chatgptToolbar, before: chatgptActions },
  );

  const chatgptModelGroup = { parentElement: chatgptActions };
  chatgptActions.parentElement = chatgptToolbar;
  styles.set(chatgptToolbar, { display: 'flex', flexGrow: '0', flexShrink: '0' });
  assert.deepEqual(
    resolveNativeFlowPlacement(chatgptRight, root, chatgptModelGroup, getStyle),
    { lane: chatgptActions, before: chatgptModelGroup },
    'single-line Chat keeps the accepted inline placement',
  );

  styles.set(chatgptToolbar, { display: 'flex', flexGrow: '0', flexShrink: '1' });
  assert.deepEqual(
    resolveNativeFlowPlacement(chatgptRight, root, chatgptModelGroup, getStyle),
    { lane: chatgptToolbar, before: chatgptActions },
    'multiline Chat promotes the root into the full free lane',
  );
});

test('usage root spans the entire free toolbar lane in every responsive mode', () => {
  const script = buildInjectorScript();
  const placementSource = sourceSection(script, 'function placeInNativeFlow(root, right) {', 'function responsiveMeasurementSignature(');
  const layoutSource = sourceSection(script, 'function layoutRoot(footer, root) {', 'function layout() {');

  assert.match(placementSource, /setStyleIfChanged\(root\.style, 'flex', '1 999 399px'\)/);
  assert.match(placementSource, /setStyleIfChanged\(root\.style, 'maxWidth', 'none'\)/);
  assert.doesNotMatch(placementSource, /'399px'/);
  assert.doesNotMatch(layoutSource, /mode === 'icon'[\s\S]*root\.style\.(?:flex|width|maxWidth)/);
});

test('squeezed model menus constrain only the native transient trigger and restore it on close', () => {
  const script = buildInjectorScript();
  const layoutSource = sourceSection(script, 'function layoutRoot(footer, root) {', 'function layout() {');
  const constraintSource = sourceSection(script, 'function expandedNativeTrigger(native) {', 'function responsiveMeasurementSignature(');
  const teardown = sourceSection(script, 'if (existing) {', 'const state = {');

  assert.match(script, /data-inline-collapse-transient-width/);
  assert.match(layoutSource, /syncNativeTriggerConstraint\(root, native\)/);
  assert.match(constraintSource, /originalMaxWidth/);
  assert.match(constraintSource, /removeProperty\('max-width'\)/);
  assert.match(constraintSource, /calculateExpandedNativeTriggerMaxWidth/);
  assert.match(teardown, /existing\.releaseNativeTriggerConstraints\?\.\(\)/);
  assert.match(teardown, /if \(existing\.nativeTriggerSettleTimer\) clearTimeout\(existing\.nativeTriggerSettleTimer\)/);
  assert.match(script, /function scheduleNativeTriggerSettle\(\) \{[\s\S]*scheduleLayout\(\);[\s\S]*\}, 180\);/);
});

test('responsive mode transitions never translate the centered balance content', () => {
  const script = buildInjectorScript();
  const layoutSource = sourceSection(script, 'function layoutRoot(footer, root) {', 'function layout() {');

  assert.match(layoutSource, /usage\.animate\(\s*\[\{ opacity: 0\.58 \}, \{ opacity: 1 \}\]/);
  assert.doesNotMatch(layoutSource, /usage\.animate\([\s\S]*translateX/);
});

test('closed popover does not eagerly create its portal during render', () => {
  const script = buildInjectorScript();
  assert.match(script, /state\.popoverShadow\s*\|\|\s*\(state\.popoverOpen\s*\?\s*ensurePopoverPortal\(\)\s*:\s*null\)/);
  assert.match(script, /function positionPopover\(\) \{\s+if \(!state\.popoverOpen \|\| !state\.popoverShadow\) return;/);
  assert.match(script, /__codexUsageView/);
});
