# v2 development and EXE packaging workflow

> 本文只适用于 `v2` 分支。v1 的使用范围与安装方式见 [docs/V1.md](./docs/V1.md)；v2 用户说明见 [docs/V2.md](./docs/V2.md)。

This document is the operational guide for developing, testing, running, packaging, upgrading, and rolling back CodexCCSwitchUsage on this computer.

## 1. Source of truth and generated copies

The only directory that should be edited is:

```text
D:\software\CodexCCSwitchUsage
```

The stable EXE installation currently lives at:

```text
D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage
```

The installed directory is a generated runtime copy. Do not make source changes there because the next installer upgrade will overwrite them.

These directories are also generated and must not be edited manually:

```text
build\
dist\
```

Runtime state is intentionally separate:

- Development state: `D:\software\CodexCCSwitchUsage\runtime`
- Stable EXE state: `D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage\runtime`

The installer preserves the stable `runtime` directory during an upgrade. A real uninstall removes it.

## 2. Important files

| File | Responsibility |
|---|---|
| `src\host.mjs` | Long-running host, quota refresh scheduling, database watcher, and HTTP-only target audits |
| `src\injector-script.mjs` | Composer footer DOM, styles, responsive layout, tooltips, refresh UI |
| `src\provider-repository.mjs` | Read-only CCSwitch SQLite access |
| `src\usage-client.mjs` | Legacy `usage_script` compatibility utilities; not used by the v2 Hub runtime |
| `src\hub-provider-adapters.mjs` | v2 provider routing and built-in balance adapters |
| `src\hub-service.mjs` | Safe multi-provider Hub state, cache, refresh concurrency, and login actions |
| `src\hub-server.mjs` / `src\hub-page.mjs` | Loopback-only Balance Hub API and page |
| `src\browser-callback-broker.mjs` | Same-port job queue and callbacks for the user's existing browser profile |
| `browser-companion\` | MV3 companion loaded into the user's normal Edge/Chrome profile |
| `src\evaluator.mjs` | Worker lifecycle and timeout handling for provider scripts |
| `src\evaluator-worker.mjs` | Sandboxed `node:vm` execution of `usage_script` |
| `src\cdp-client.mjs` | Short-lived CDP HTTP/WebSocket client and strict target filtering |
| `src\target-session.mjs` | One-shot injector installation, hot replacement, and payload delivery |
| `src\keyed-backoff.mjs` | Target-keyed bounded retry state for failed one-shot injector installations |
| `src\page-action-channel.mjs` | Invisible, bounded page-title action markers for refresh and Hub clicks |
| `scripts\launch.ps1` | Finds/starts Codex with CDP, starts the host, activates the window |
| `scripts\stop-host.ps1` | Stops plugin hosts without stopping Codex |
| `scripts\stop.ps1` | Stops plugin hosts and the Codex process tree; not for normal development reloads |
| `packaging\launcher\Program.cs` | Hidden Windows EXE wrapper that launches the existing PowerShell flow |
| `packaging\setup.iss` | Inno Setup installer definition |
| `scripts\build-exe.ps1` | Repeatable launcher/installer build |

### v2 single balance center

The v2 host is the only balance-query center. The Codex footer, Hub page, and loopback balance API all call `HubService`; none executes the CCSwitch `usage_script` or calls the retired Python bridge.

The stable gateway listens on `127.0.0.1:17891` and exposes `/v1/balance/{provider}`, `/v1/balances`, `/v1/providers`, `/v1/health`, plus the legacy-compatible `/usage/{provider}` path. CCSwitch remains read-only and its existing scripts are not rewritten during v2 development.

Provider adapters first use the CCSwitch API Key and configured Base URL when the third-party site supports a balance endpoint. Sites whose model API keys cannot access dashboard balances use the MV3 browser companion after one-time pairing with the Hub token. The companion runs requests inside the user's existing Edge/Chrome profile, keeps Cookie values in that browser, and returns only request results through the same port. Hub opening never triggers refresh. A balance query never creates or activates a website tab; session synchronization and login pages require an explicit user action.

Every provider with a built-in HTTPS login configuration always exposes that sanitized official login URL in Hub state. The card renders it independently from query status, cached usage, CCSwitch `website_url`, companion connectivity, and WAF classification. `sessionSyncRequired` controls only the separate session-sync action; it must never hide the official login link.

The companion stores its pairing token, stable client id, allowlisted validated origins, and the numeric New API user id required beside browser cookies in `chrome.storage.local`; it never stores Cookie values, Token values, or localStorage source text. Each startup or reconnect begins with one session heartbeat; subsequent long polls carry only client identity and wait for explicit jobs. Ordinary loopback callbacks have a 10,000 ms client timeout, 25,000 ms server long polls have a 30,000 ms client timeout, and each 120-poll batch hands off immediately instead of waiting for the next one-minute alarm. Browser queries reserve 5,000 ms of their job budget for an existing-tab fallback after an extension-context request. A polling iteration reuses one configuration snapshot, repeated status/session values are not rewritten, and event-driven heartbeats are coalesced as a single-flight 350 ms trailing update. New API sites such as AnyRouter and AgentRouter are never restored from arbitrary Cookie presence alone. The provider response is authoritative: successful responses retain the hint, while an explicit authentication failure removes it; ordinary provider or WAF failures preserve the last validated hint. A connected companion may attempt the real same-origin query even before a hint is restored, so a host restart cannot be misclassified as logout. Each Hub provider card exposes a safe “查看” dialog for the actual request URL, method, authentication category, executor, browser/WAF dependency, and current normalized source; credentials are never included.

The old standalone Python bridge must not run alongside v2 because both use port `17891`.

## 3. Enter development mode

The stable EXE host normally runs from the installed directory. Stop all plugin copies, then start the workspace copy:

```powershell
Set-Location 'D:\software\CodexCCSwitchUsage'
$root = (Get-Location).Path

& .\scripts\stop-host.ps1 `
  -InstallRoot $root `
  -AllInstances

& .\scripts\launch.ps1 `
  -InstallRoot $root
```

`stop-host.ps1` does not close Codex. When Codex is already running with port `9334`, `launch.ps1` reuses that Codex process and starts only the workspace host.

If only an ordinary Codex process without port `9334` is running, `launch.ps1` first asks it to close normally and then automatically restarts Codex with CDP enabled. It does not show a confirmation before the normal restart. If Codex has not exited after 10 seconds, the launcher still asks before force-terminating it because that can interrupt active work or unsent input.

While the workspace host is active, do not click “Codex + CCSwitch 用量” on the desktop or Start menu. Those shortcuts intentionally point to the stable EXE installation.

Check development status with:

```powershell
& .\scripts\status.ps1 -InstallRoot (Get-Location).Path
```

Or inspect:

```powershell
Get-Content .\runtime\status.json -Raw
```

Expected fields include:

```json
{
  "running": true,
  "eventDrivenTargets": false,
  "databaseWatch": true,
  "targetInstallFailures": 0,
  "targetInstallRetryMs": 0,
  "connectedPages": 1,
  "connectionError": null
}
```

### Host background performance baseline

The injected refresh and Hub buttons append a bounded invisible action marker (`refresh` or `open-hub`) to `document.title`. The host reads the short-lived `/json/list` HTTP snapshot every 1,000 ms and acknowledges an exact marker through an isolated one-shot CDP operation before dispatching it. Marker acknowledgement never updates the quota payload, never waits for provider network I/O, and does not require a second target snapshot. Refreshes are coalesced as one active request plus at most one trailing request; only the final queued result is injected, while Hub actions remain responsive during the query. A newer title marker cannot be cleared by acknowledgement of an older click. This title channel carries no provider data or credential and avoids a persistent CDP WebSocket. Each CDP HTTP request uses `Connection: close`; full injector audits remain limited to 300,000 ms and are deferred while the current-provider query is active.

The CCSwitch database uses `fs.watch` for immediate changes. While the watcher is healthy, the three SQLite files are audited only every 60,000 ms; the 1,000 ms retry is used only when a watcher is unavailable. SQLite/WAL activity that leaves the cached provider snapshot unchanged does not rebuild Hub state, increment its revision, or request a current-provider refresh. The Hub page loads state once and polls only while a user-started refresh operation is in progress. Only the current CCSwitch provider owns a fixed 300,000 ms balance timer.

CDP target isolation is fail-closed. The host connects only to a `page` target whose URL is exactly the canonical Codex main document, `app://-/index.html`, with no query or fragment. Every eligible target WebSocket exists only for the inspection/injection/update call and is closed in `finally`; a socket whose handshake times out or fails is closed before ownership can transfer to a client. Deferred audits remain pending but never accelerate the maintenance loop beyond the 1,000 ms page-action cadence. A persistent one-shot installation failure uses a target-keyed `1,000 / 2,000 / 5,000 / 10,000 / 30,000 ms` retry sequence; a replacement target or new page action bypasses the old target's delay. The host never calls browser-wide `Target.setDiscoverTargets`, never keeps a target session, and never calls `Runtime.enable` or `Runtime.addBinding`. Empty URLs, `about:blank`, external pages, Browser Use WebViews, MCP App guests, and auxiliary `initialRoute` windows are never connected. If any auxiliary `page`, `webview`, or `iframe` target is active, all injector connections are deferred until it disappears.

Hub full refresh keeps its existing total concurrency bound while reserving a serial lane for providers that require the browser companion, so a slow browser callback cannot occupy every direct-API worker. Hub state records `queryDurationMs` per provider and `lastFullRefreshDurationMs` for the complete operation; these fields contain timing only and never credentials.

OpenAI WHAM queries keep the direct Node transport as the fast path. When the browser companion is connected, the browser path starts only if the direct probe has not completed after 400 ms; the first usable result wins and cancels the losing transport. The direct probe remains bounded by 5,000 ms, and a successful browser result suppresses repeated direct probes for 300,000 ms. A failed browser fallback does not open that backoff, and companion-offline queries retain the direct retry policy. All ordinary provider HTTP retries share one 40,000 ms total budget instead of resetting it for every attempt, and a complete provider query has a 45,000 ms global deadline. Concurrent and 30,000 ms recent successful WHAM results are shared by the SHA-256 hash of account id plus access token, allowing overlapping OpenAI and CPA providers to avoid duplicate requests without caching credential text; failures are never cached.

### Balance positioning invariant

The injected balance content is centered in the currently available free lane, not in the whole composer and not relative to its own maximum width:

```text
left composer controls |          dynamic free lane          | native right controls
                                      ↑
                              balance content center
```

This rule applies to every responsive mode, including the icon-only mode. The root container must continue to fill the entire free lane. Responsive compression hides lower-priority content inside that full-width root; it must not reduce the root to the content width or align it against the native right controls.

Do not reintroduce a fixed root `max-width` or an icon-mode `flex: 0 0 28px` root. Visual/runtime verification should compare the visible content-group center with the free-lane center and keep the difference within `0.5px`.

### Codex App interaction layout performance baseline

The injector layout policy was verified against the live Codex App through CDP function coverage, using controls inside the mounted primary composer footer rather than similarly named controls from transient side-task surfaces. The current injector version is `69`; its title-action transport, mounted root, Codex layout, ChatGPT Work layout, and ChatGPT Chat multiline/compressed layout were smoke-tested on Codex Desktop `26.715.2305.0`. Update the exhaustive interaction baseline only after completing the corresponding full live regression.

| Codex interaction | Expected injector geometry work |
|---|---|
| Focus composer, type/delete one line, grow/shrink a multiline editor | No layout |
| Open attachment, access, search, task, or top application menus | No layout |
| Expand/collapse command results, scroll messages, jump to a message | No layout |
| Toggle the left sidebar, pinned summary, or bottom panel while the composer footer remains mounted | No layout; native flow moves the balance with the composer |
| Change the access label between Full Access and Agent Approval | No layout while the free-lane width and responsive mode remain unchanged |
| Open or close the animated model/reasoning menu | No layout when the current responsive mode still fits; native flex absorbs the width animation |
| Animate a side panel that changes the free-lane width | Layout only when the predicted responsive mode crosses a threshold, plus the existing 180 ms direction-settle layout |
| Click refresh outside icon mode | Render the loading attribute without scheduling layout |
| Click refresh in icon mode | Layout is allowed because the balance popover is toggled and must be positioned |
| Switch tasks while Codex reuses the composer | No layout |
| Switch tasks or toggle a surface that replaces the composer | Immediate recovery and one full responsive measurement for the new root |
| Enter Settings, Plugins, Scheduled/Automations, or Pull Requests | Zero layouts; the composer and balance root are removed and the injector remains unmounted |
| Return from a non-composer page to a task | One layout that mounts and fully measures the new composer root |

Measured regression results for the animated model/reasoning menu:

```text
injector 54: open 43 layouts, close 44 layouts
injector 55-56: open 2 layouts, close 2 layouts
injector 57: open 0 layouts, close 0 layouts when the mode remains full
responsive mode changes: 0
full responsive measurements during open/close: 0

non-composer page return:
injector 56: 2 layouts and 1 full measurement
injector 57: 1 layout and 1 full measurement
```

The root container remains observed because sibling native controls can change the free-lane width without resizing the overall footer. Initial observations are seeded with the current root size, and changes of `0.5px` or less are ignored. For meaningful root changes, cached responsive widths predict whether the selected mode would change; geometry work is scheduled only when that threshold is crossed. A collapsed composer still enters the immediate recovery path, but no layout is scheduled when recovery finds no composer.

The exhaustive Codex `26.707.9564.0` audit covered 47 task-page interaction types, all 19 Settings categories, Plugins/Skills/search/filter/refresh/manage flows, Scheduled/Automations navigation, Pull Request filters/search, ChatGPT/Codex mode switching, access-mode changes, real reasoning-intensity changes, the balance tooltip, and the balance refresh path. Repeated message and task controls were tested by behavior type. Side-effect actions were not committed: no logout, task creation/archive/pin, like/dislike, message send, dictation, file upload, plugin installation, automation creation, or account/billing submission.

Do not replace this policy with unconditional per-frame resize layouts. Regression tests in `tests\injector-tooltip.test.mjs` enforce initial-size seeding, threshold-driven responsive layout, collapsed-composer recovery, and the refresh loading fast path.

## 4. Normal edit/test/reload loop

### Hot-update invariant

All ordinary development and performance-optimization iterations are hot updates. Codex must remain open throughout the cycle. The root `ChatGPT.exe` process ID must be the same before and after the update.

Before reloading, record the current root PID:

```powershell
$codexPidBefore = @(
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' } |
    Select-Object -ExpandProperty ProcessId
)
```

Then test and hot-reload only the plugin host:

Make changes only in the workspace, then run:

```powershell
npm test
```

After tests pass, reload the workspace host:

```powershell
$root = (Get-Location).Path
& .\scripts\stop-host.ps1 -InstallRoot $root -AllInstances
& .\scripts\launch.ps1 -InstallRoot $root
```

This reload does not restart Codex.

Verify that the Codex/ChatGPT root PID did not change:

```powershell
$codexPidAfter = @(
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' } |
    Select-Object -ExpandProperty ProcessId
)

if (Compare-Object $codexPidBefore $codexPidAfter) {
  throw 'Hot update restarted Codex/ChatGPT unexpectedly.'
}
```

The allowed hot-update sequence is:

```text
edit source → run tests → stop plugin Node host → start workspace host → hot-replace injector
```

The following sequence is forbidden during ordinary development:

```text
stop or close ChatGPT.exe → restart Codex → reload plugin
```

Never call `scripts\stop.ps1` for a development reload because it intentionally terminates the Codex process tree. If port `9334` is not available on the existing Codex process, stop and report the condition instead of restarting Codex without explicit user approval.

### Injector changes

If a change affects UI, CSS, DOM structure, responsive behavior, observers, event handlers, tooltips, or injected page helpers, increment the current `INJECTOR_VERSION` integer in `src\injector-script.mjs` by one. Do not copy a fixed example value from this document. Without a version increase, an already-open Codex page can keep the previous injector because the target session sees the same installed version.

Changes limited to the host, SQLite repository, quota request, evaluator, CDP transport, or PowerShell scripts do not require an injector version increase.

## 5. Return to the stable EXE without packaging

To abandon or pause development changes and return to the currently installed version:

```powershell
Set-Location 'D:\software\CodexCCSwitchUsage'
$root = (Get-Location).Path

& .\scripts\stop-host.ps1 `
  -InstallRoot $root `
  -AllInstances

& 'D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage\CodexCCSwitchUsage.exe'
```

Verify that only one plugin host remains and that it uses the bundled Node executable from the installed directory.

## 6. Prepare a stable release

### Explicit packaging approval gate

Development completion, passing tests, a successful hot update, or a Codex recommendation does not authorize EXE packaging. Remain in workspace development mode until the user explicitly confirms that the current result may be packaged as an EXE.

Before that confirmation, do not:

- run `npm run build:exe`;
- compile `packaging\launcher\Program.cs`;
- run Inno Setup;
- create or replace a Setup EXE;
- install over the stable EXE version;
- change the stable installation directory or shortcuts.

The expected user authorization is an unambiguous instruction such as “可以打包 EXE”, “现在打包”, or an equivalent direct request.

After the user gives that confirmation and development behavior is satisfactory:

1. Run the complete test suite.
2. Choose a new semantic version in `package.json`, such as `1.0.1`.
3. Confirm `INJECTOR_VERSION` was incremented if injected behavior changed.
4. Build the installer.

```powershell
Set-Location 'D:\software\CodexCCSwitchUsage'
npm test
npm run build:exe
```

The build script validates all of the following before producing an installer:

- Node is version 22 or newer;
- Node architecture is x64;
- `node:sqlite` loads successfully;
- the .NET Framework launcher compiles;
- the launcher can find and execute the bundled Node runtime;
- Inno Setup successfully compiles the installer.

The result is written to:

```text
dist\CodexCCSwitchUsage-Setup-<version>.exe
```

`scripts\build-exe.ps1` prints the final size and SHA-256 hash.

## 7. Install or upgrade the stable EXE

Run the newly generated Setup EXE. Do not uninstall the previous version first. The fixed Inno Setup `AppId` makes it an in-place upgrade.

During an upgrade, the installer:

1. finds and stops workspace or installed plugin hosts;
2. never stops the Codex application;
3. replaces program and bundled Node files;
4. preserves installed `runtime` cache and state;
5. preserves the selected installation directory;
6. always creates or repairs the Start-menu shortcut so Windows Search can discover “Codex + CCSwitch 用量”; the desktop shortcut remains controlled by the install task selection;
7. starts the stable host when the post-install launch option remains selected.

The Start-menu shortcut must not be guarded by an optional or `checkedonce` task. Every fresh install, reinstall, and in-place upgrade must write it to `{userprograms}` and point it at the installed `CodexCCSwitchUsage.exe` launcher.

After installation, verify:

```powershell
$stable = 'D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage'
& "$stable\scripts\status.ps1" -InstallRoot $stable
```

The registered application name is `Codex CCSwitch Usage <version>` and it can be removed from Windows “Installed apps”.

## 8. Packaging toolchain

The current machine uses:

- Node.js 22.22.1 x64 for the bundled runtime;
- .NET Framework 4.8 `csc.exe` for the small hidden launcher;
- Inno Setup 6.7.3 for the Setup EXE.

Install Inno Setup for the current user if it is missing:

```powershell
winget install `
  --id JRSoftware.InnoSetup `
  --exact `
  --scope user `
  --accept-source-agreements `
  --accept-package-agreements
```

The EXE is currently unsigned because it is for personal use. Windows may show an unknown-publisher warning. Do not claim it is signed.

## 9. Uninstall rules

For the EXE-installed version, use either:

- Windows Settings → Apps → Installed apps → Codex CCSwitch Usage; or
- `D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage\unins000.exe`.

Do not use `scripts\uninstall.ps1` for the EXE-installed version. That script belongs to the earlier PowerShell-copy installation and would bypass the Inno Setup registration record.

## 10. Troubleshooting

### Two plugin hosts are running

Run:

```powershell
Set-Location 'D:\software\CodexCCSwitchUsage'
& .\scripts\stop-host.ps1 -InstallRoot (Get-Location).Path -AllInstances
```

Then start exactly one mode: workspace development or installed stable EXE.

### UI changes do not appear

Confirm all three items:

1. `INJECTOR_VERSION` was incremented;
2. the workspace host was restarted;
3. `runtime\status.json` shows a connected page and no connection error.

### EXE build fails

Check:

```powershell
node --version
node --no-warnings --experimental-sqlite -e "require('node:sqlite'); console.log(process.arch)"
```

Expected architecture is `x64`. Then confirm Inno Setup exists at either:

```text
%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
```

### Do not modify Codex internals

This project intentionally uses a sidecar host plus CDP. Do not patch `app.asar`, Electron preload code, or the Codex MSIX package. Those changes are update-fragile and outside the supported project design.
