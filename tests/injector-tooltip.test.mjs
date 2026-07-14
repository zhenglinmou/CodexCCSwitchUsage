import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildInjectorScript,
  calculateResponsiveMeasurements,
  classifyComposerMutations,
  createInjectorEventController,
  findMutationObserverTarget,
  findUsageTooltipTarget,
  getUsageFreshness,
  HUB_BINDING,
  INJECTOR_VERSION,
  isNativeFlowCacheValid,
  isUsageTooltipBoundaryCrossing,
  mutationNeedsComposerSync,
  REFRESH_BINDING,
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
  assert.match(buildInjectorScript(), new RegExp(`,${INJECTOR_VERSION}\\)$`));
});

test('injector caches hot-path usage and refresh DOM references on each root', () => {
  const source = fs.readFileSync(new URL('../src/injector-script.mjs', import.meta.url), 'utf8');

  assert.match(source, /root\.__codexUsageElement/);
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

test('refresh button notifies the host through the exported CDP binding', () => {
  assert.match(buildInjectorScript(), new RegExp(REFRESH_BINDING));
});

test('balance content and icon popover expose the v2 Balance Hub binding', () => {
  const script = buildInjectorScript();
  assert.match(script, new RegExp(HUB_BINDING));
  assert.match(script, /action: 'open-hub'/);
  assert.match(script, /id="open-hub"/);
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

  assert.equal(classifyComposerMutations([{ addedNodes: [textNode, unrelatedElement], removedNodes: [] }], footer, root), 'ignore');
  assert.equal(classifyComposerMutations([{ addedNodes: [editorElement], removedNodes: [] }], footer, root), 'mount');
  assert.equal(classifyComposerMutations([{ target: footerChild, addedNodes: [unrelatedElement], removedNodes: [] }], footerWithChildren, root), 'ignore');
  assert.equal(classifyComposerMutations([{ addedNodes: [unrelatedElement], removedNodes: [] }], footer, detachedRoot), 'ignore');
  assert.equal(classifyComposerMutations([{ addedNodes: [], removedNodes: [detachedRoot] }], footer, detachedRoot), 'mount');
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

test('root resize schedules layout only when the responsive mode must change', () => {
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
  assert.match(resizeObserver, /if \(!rootChanged\) return;/);
  assert.match(resizeObserver, /if \(roots\.some\(rootResizeNeedsLayout\)\) scheduleLayout\(\);/);
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
  assert.equal(findUsageTooltipTarget(target({ '.refresh': {} })), null, 'refresh button must not trigger the balance tooltip');
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
    "refreshButton.addEventListener('click', event => {",
    'function ensureUsageElement(instance) {',
  );

  assert.match(refreshHandler, /const shouldScheduleLayout = instance\.root\.dataset\.mode === 'icon';/);
  assert.match(refreshHandler, /if \(shouldScheduleLayout\) state\.popoverOpen = !state\.popoverOpen;/);
  assert.match(refreshHandler, /render\(null, shouldScheduleLayout\);/);
  assert.doesNotMatch(refreshHandler, /\n\s*render\(\);/);
});

test('toolbar flow cache is reused only while its DOM placement remains valid', () => {
  const right = {};
  const before = { isConnected: true };
  const lane = { isConnected: true };
  const root = { parentElement: lane, nextElementSibling: before };
  const cache = { right, lane, before };

  assert.equal(isNativeFlowCacheValid(cache, root, right), true);
  assert.equal(isNativeFlowCacheValid(cache, { ...root, nextElementSibling: null }, right), false);
  assert.equal(isNativeFlowCacheValid({ ...cache, before: { isConnected: false } }, root, right), false);
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

test('closed popover does not eagerly create its portal during render', () => {
  const script = buildInjectorScript();
  assert.match(script, /state\.popoverShadow\s*\|\|\s*\(state\.popoverOpen\s*\?\s*ensurePopoverPortal\(\)\s*:\s*null\)/);
  assert.match(script, /function positionPopover\(\) \{\s+if \(!state\.popoverOpen \|\| !state\.popoverShadow\) return;/);
  assert.match(script, /__codexUsageView/);
});
