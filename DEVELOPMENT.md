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

The regression suite under `tests\` is version controlled and runs through both `npm test` and the Windows GitHub Actions workflow. Runtime installation and EXE packaging continue to use explicit payload lists, so tests are not shipped with the application.

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
| `src\provider-request-usage.mjs` | Third-party per-request Token and charge adapters |
| `src\provider-templates.mjs` | Independent balance/request template registry and credential-free bindings |
| `src\hub-service.mjs` | Safe multi-provider Hub state, cache, refresh concurrency, and login actions |
| `src\hub-server.mjs` / `src\hub-page.mjs` | Loopback-only Balance Hub API and page |
| `src\hub-preferences.mjs` | Credential-free Hub view mode, favorites, sorting, and browser display aliases |
| `src\browser-callback-broker.mjs` | Same-port job queue and callbacks for the user's existing browser profile |
| `browser-companion\` | MV3 companion loaded into the user's normal Edge/Chrome profile |
| `src\evaluator.mjs` | Worker lifecycle and timeout handling for provider scripts |
| `src\evaluator-worker.mjs` | Sandboxed `node:vm` execution of `usage_script` |
| `src\cdp-client.mjs` | Short-lived CDP HTTP/WebSocket client and strict target filtering |
| `src\target-session.mjs` | One-shot injector installation, hot replacement, and payload delivery |
| `src\keyed-backoff.mjs` | Target-keyed bounded retry state for failed one-shot injector installations |
| `src\page-action-channel.mjs` | Invisible, bounded page-title pending-action queue for refresh and Hub clicks |
| `src\process-lifecycle.mjs` | Exact Codex root-process liveness monitor; no CDP session ownership |
| `scripts\launch.ps1` | Finds/starts Codex with CDP, starts the host, activates the window |
| `scripts\stop-host.ps1` | Stops plugin hosts without stopping Codex |
| `scripts\stop.ps1` | Stops plugin hosts and the Codex process tree; not for normal development reloads |
| `packaging\launcher\Program.cs` | Hidden Windows EXE wrapper that launches the existing PowerShell flow |
| `packaging\setup.iss` | Inno Setup installer definition |
| `scripts\build-exe.ps1` | Repeatable launcher/installer build |

### v2 single balance center

The v2 host is the only balance-query center. The Codex footer, Hub page, and loopback balance API all call `HubService`; none executes the CCSwitch `usage_script` or calls the retired Python bridge.

The stable gateway listens on `127.0.0.1:17891` and exposes cache-only `/v1/balance/{provider}`, `/v1/balances`, and legacy-compatible `/usage/{provider}` reads, plus `/v1/providers` and `/v1/health`. Explicit external refreshes use the token-protected Hub POST route. CCSwitch remains read-only and its existing scripts are not rewritten during v2 development.

The installer and source installer protect the complete target tree with a non-inherited Windows DACL owned by the current user and grant access only to that user, SYSTEM, and Administrators. Development launches reapply the same policy to `runtime` before the host reads or writes `hub-token`. ACL hardening rejects reparse-point roots and fails closed; it never continues startup or installation with a broadly readable token or modifiable installed source tree.

The token-protected `/api/<hub-token>/request-usage` route is the per-request usage source for the current-provider recent-request popover. Opening or refreshing that popover requests the latest 10 Codex records. It prefers a supported third party's real token/quota charge records and falls back to clearly marked CCSwitch `proxy_request_logs` estimates when the remote interface is unavailable. OpenAI Official is a local exception: it reads Codex `token_count` events from `~/.codex/sessions` and `~/.codex/archived_sessions`, returns the official input/output/cache/reasoning Token counts, and leaves per-request cost unavailable because a ChatGPT subscription does not expose a per-call charge. The reader parses only `session_meta`, `turn_context`, and `token_count`, ignores conversation content, rejects non-OpenAI sessions, and activates only when the provider account id matches the current `~/.codex/auth.json` account. It scans newest files first, persists a bounded derived index under `runtime`, incrementally parses only verified append-only tails, and caps both retained files and per-file rows; the index contains no conversation text or credentials. Local fallback SQL is fixed to `app_type = 'codex'`. When one API Key is reused by Codex and Claude/Claude Desktop, remote rows are classified before applying the 10-row limit: `/v1/responses` and OpenAI-compatible paths are Codex, `/v1/messages` and Anthropic paths are Claude, and model families are used only when the path is absent. Ambiguous rows from a cross-app shared Key are excluded rather than mixed into the Codex list.

Balance and per-request usage templates are selected independently. Hub exposes token-protected template catalog, probe, and selection routes. Balance and per-request probes run together under one 12,000 ms budget; identical URL/authentication requests share one in-memory parsed response, balance schemas retain their priority order, and only normalized previews through the first validated schema are returned. Packy/effective-Key and standard Key capabilities are checked before a browser-account default, including for providers whose built-in profile currently prefers browser balances. A validated standard unlimited-Key response remains a template match even when browser login or session synchronization is still required. Once a higher-priority match is selected, the shared probe controller aborts speculative loser requests so their retry timers and sockets do not remain active in the background. Window quota payloads must also satisfy `total = used + remaining` for every window. Manual bindings are written to `runtime\hub-template-bindings.json` with provider id, configured origin, template ids, and timestamps only. Changing the provider origin invalidates the binding, and API Keys are never persisted in this file.

Per-request template auto-detection always probes with a limit of 10 and never persists its recommendation. A non-empty `/api/log/token` response must contain at least one recognizable New API request-activity row: either a `type = 2` consumption row or a `type = 5` request-error row with meaningful model, quota, Token, timing, or request metadata. Zero-Token/zero-cost error rows remain valid, while account-only events, content-only lookalikes, and rows whose request fields exist only as empty/null placeholders are rejected. An empty Token log is accepted as zero only when `/api/status` independently validates the New API billing schema and no recent local evidence requires stricter attribution. Empty or WAF-blocked Token logs may instead use `/api/log/self` only after at least two recent successful local requests correlate to one remote Token identity. Correlation requires matching time, model, and input Tokens. Completion Tokens must match exactly for other New API providers; AnyRouter alone may accept a positive remote completion count below the local output count because its account log omits reasoning output. `token_id` is authoritative; a compatibility fallback without it returns only the individually correlated `token_name` rows. Same-key AnyRouter API-only mirrors use the canonical `anyrouter.top` provider's request template, browser binding, and local correlation records while retaining their own public provider identity and model Base URL. HTTP 401 never enters the account-log fallback. Valid Token logs with unavailable billing configuration remain usable but degraded and non-exact; unverified account scope, `record not found`, authentication, network, and schema failures continue to the CCSwitch-local fallback probe.

Provider adapters first use the CCSwitch API Key and configured Base URL when the third-party site supports a balance endpoint. Remote HTTP remains denied by default. A local `~/.cc-switch/allow-http-origins.json` may opt in one exact provider id plus HTTP origin; the exception is direct-host-only, is port-pinned, and never expands browser-companion permissions. Sites whose model API keys cannot access dashboard balances use the MV3 browser companion after one-time pairing with the Hub token. The companion runs requests inside the user's existing Edge/Chrome profile, keeps Cookie values in that browser, and returns only request results through the same port. Hub opening never triggers refresh. A balance query never creates or activates a website tab; session synchronization and login pages require an explicit user action.

The known `jianzhile.vip`, `free.lyclaude.site`, `muyuan.do`, `welfare.0xpsyche.me`, and `mofas.one` profiles query finite API Keys directly and use the browser companion when the site reports a standard unlimited Key whose real balance belongs to the logged-in account. Their site display configuration controls quota units and exchange rates; placeholder unlimited values are never rendered as balances. Muyuan additionally supports a same-origin browser API fallback for finite Keys blocked by WAF and a clearly marked CCSwitch-local estimate if the remote query still fails. Packy is treated as a New API family extension, not a separate protocol: a `/api/usage/token/` response with `total_available`, `total_used`, and `quota_reset_period` is an effective Key quota that remains directly queryable even when `unlimited_quota` is true. Auto-detection tests this more specific capability before the standard New API Key/account behavior. Routing is pinned to the configured API hostname, so a provider name alone cannot send credentials to any fixed domain.

Every provider with a built-in HTTPS login configuration always exposes that sanitized official login URL in Hub state. The provider row renders it independently from query status, cached usage, CCSwitch `website_url`, companion connectivity, and WAF classification. `sessionSyncRequired` controls only the separate session-sync action; it must never hide the official login link.

Hub workspace preferences are separate from provider and credential state. Card/compact view mode, favorites, sorting, opaque browser-client display aliases, and provider-to-browser preferences containing only a provider id, opaque client reference, and normalized browser name are validated and written atomically to `runtime\hub-preferences.json`; this file never contains API Keys, Cookie values, login identities, request bodies, or CCSwitch configuration. Browser-type provider rows expose the resolved Edge/Chrome target in the status column. Resolution prefers an explicit account binding, the user's last provider-specific choice, the last successful account browser, and a unique validated same-origin session; ambiguous multi-browser sessions remain visibly unassigned. Rows requiring website authentication, session synchronization, or account binding keep a separate refresh action visible beside the corrective action, so the second step never depends on expanding row details. The browser task center groups corrective actions by the exact opaque Edge/Chrome client reference and limits batch rechecks to those providers. After a user explicitly opens a login page, the Hub keeps only a tab-scoped, credential-free pending marker; leaving and returning to the Hub triggers one refresh attempt, and a failed attempt becomes a manual recheck instead of polling indefinitely. The token-protected Hub state includes a whitelisted host diagnostic snapshot, while the five-second companion-status route remains lightweight and never rebuilds full provider state.

The companion stores its pairing token, stable client id, browser scope, validated HTTPS origins, and the numeric New API user id required beside browser cookies in `chrome.storage.local`; it never stores Cookie values, Token values, or localStorage source text. Edge and Chrome may connect simultaneously with independent client ids and sessions. The host also scopes its live connection key by client id plus browser, publishes only an opaque client reference to Hub, and uses that reference for explicit “在 Chrome / Edge 验证” actions. Upgrading from an older companion migrates a copied cross-browser client id to a browser-specific identity. For multiple accounts on one New API origin, the host sends account probes to each exact client, checks the site's masked token listing against the provider API Key locally, and accepts only the owning account; the complete API Key is never sent to either browser. AnyRouter deployments that return a structurally valid empty Token list support an explicit provider-to-browser binding. Binding stores an opaque SHA-256 account reference in `hub-cache.json`, never the numeric user id, and every refresh targets only that exact Edge or Chrome client. A changed browser account invalidates the reference and clears the old balance instead of falling back to another browser. Duplicate AnyRouter providers share a binding and result only when their complete API Keys are identical; distinct Keys are isolated and require separate bindings. A single distinct AnyRouter credential may still use the sole validated browser session before it is explicitly bound. Each startup or reconnect begins with one session heartbeat; subsequent long polls carry only client identity and wait for explicit jobs. Heartbeats and job polls negotiate companion protocol version `2` plus an explicit capability set. Each claimed job receives a random one-time result proof bound to the exact client id, browser, and MV3 worker instance; stale or different clients cannot complete it. Client, session, waiter, and pending-job tables have hard limits, and expired clients are deleted rather than retained as inactive entries. Ordinary loopback callbacks have a 10,000 ms client timeout, 25,000 ms server long polls have a 30,000 ms client timeout, and each 120-poll batch hands off immediately instead of waiting for the next one-minute alarm. A complete provider query, broker callback wait, and browser job use aligned 45,000 / 44,000 / 40,000 ms deadlines. Browser jobs carry the host expiration time and reserve 2,000 ms to deliver their result. The extension-context request is the fast path for an existing browser session; an awake same-origin tab is a bounded fallback. Each transport attempt is limited to 8,000 ms, and an HTML or Cloudflare challenge response is classified from its headers without waiting for an unbounded response body. `Content-Length` is only an early oversize guard because Fetch exposes decoded bytes; completion requires either a valid complete JSON value or stream end. A polling iteration reuses one configuration snapshot, repeated status/session values are not rewritten, and event-driven heartbeats are coalesced as a single-flight 350 ms trailing update. New API sites such as AnyRouter and AgentRouter are never restored from arbitrary Cookie presence alone. The provider response is authoritative: successful responses retain the hint, while an explicit authentication failure removes it; ordinary provider or WAF failures preserve the last validated hint. A connected companion may attempt the real same-origin query even before a hint is restored, so a host restart cannot be misclassified as logout. Each Hub provider card exposes a safe “模板” dialog for independent balance/request selection plus the actual request URL, method, authentication category, executor, browser/WAF dependency, and current normalized source; credentials are never included.

The loopback Hub origin is a required host permission. HTTPS is only an optional permission envelope; each heartbeat supplies the exact origins required by the current provider templates, and the popup requests only those origins after an explicit user click. Before every provider job the worker checks the exact origin with `chrome.permissions.contains`; a withheld Edge/Chrome site-access permission is reported as a website-permission problem, never as a logged-out browser session.

Long polls also carry a worker `instanceId`. A replacement MV3 worker supersedes the previous wait, requeues any unfinished job claimed by the obsolete instance with its original id and deadline, and cancels the previous waiter. An aborted HTTP request removes its waiter immediately. Successful 120-poll batches still hand off without delay; repeated connection failures use bounded jittered backoff and yield to the one-minute alarm after the third failure instead of keeping the service worker awake indefinitely.

Hub cache entries include a SHA-256 configuration fingerprint without credential text. A provider id whose API Key, Base URL, authentication, or usage configuration changes cannot inherit the old account balance. `lastSuccessAt` and `lastAttemptAt` are separate; failed attempts preserve the real age of the displayed balance.

The old standalone Python bridge must not run alongside v2 because both use port `17891`.

When the Windows user proxy is enabled, `scripts\launch.ps1` reads only its endpoint from the current user's Internet Settings and passes it to the Node host through `HTTP_PROXY`/`HTTPS_PROXY` with Node's `--use-env-proxy` flag. `127.0.0.1`, `localhost`, and `::1` are kept in `NO_PROXY`; the endpoint is never written to Hub state or logs. The packaged launcher inherits the same process environment and enables the same Node flag.

### Local CPA scope

For this computer, CLIProxyAPI (CPA) is an optional external state and is not part of the v2 acceptance or repair scope. CPA file scanning, account enabled/disabled flags, expired tokens, and multi-account selection may be recorded as known limitations, but they are not blockers for v2 work. Revisit CPA behavior only when the user explicitly asks for it.

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

If only an ordinary Codex process without port `9334` is running, workspace development mode stops and reports that hot update is unavailable; it does not ask Codex to close. A user-facing installed shortcut passes the explicit `-AllowCodexRestart` authority. With that authority, `launch.ps1` asks Codex to close normally and restarts it with CDP enabled; if Codex has not exited after 10 seconds, it still asks before force-terminating because that can interrupt active work or unsent input.

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
  "codexProcessId": 46300,
  "eventDrivenTargets": false,
  "databaseWatch": true,
  "codexProcessPollMs": 1000,
  "targetInstallFailures": 0,
  "targetInstallRetryMs": 0,
  "connectedPages": 1,
  "connectionError": null,
  "usageCacheError": null
}
```

### Host background performance baseline

The injected refresh and Hub buttons maintain a bounded invisible pending-action queue in `document.title`. The queue can retain one latest `refresh` and one latest `open-hub` simultaneously, so a rapid second action cannot overwrite the first. The host reads the short-lived `/json/list` HTTP snapshot every 1,000 ms and acknowledges the exact batch through an isolated one-shot CDP operation before dispatching every action in it. Marker acknowledgement never updates the quota payload, never waits for provider network I/O, and does not require a second target snapshot. Refreshes are coalesced as one active request plus at most one trailing request; only the final queued result is injected, while Hub actions remain responsive during the query. A newer title batch cannot be cleared by acknowledgement of an older click. This title channel carries no provider data or credential and avoids a persistent CDP WebSocket. The HTTP snapshots reuse one bounded keep-alive socket to avoid a new loopback TCP handshake every second; the agent is destroyed during host shutdown. Full injector audits remain limited to 300,000 ms and are deferred while the current-provider query is active.

The recent-request popover reads the CCSwitch `latency_ms` and `first_token_ms` fields and displays them as total/first-token time. Popovers move keyboard focus into the dialog, restore it on `Escape`, and expose their expanded/loading state through ARIA. A refresh loading indicator clears itself after 95,000 ms if no payload arrives, without issuing another request.

The CCSwitch database uses `fs.watch` for immediate changes. While the watcher is healthy, the three SQLite files are audited only every 60,000 ms; the 1,000 ms retry is used only when a watcher is unavailable. SQLite/WAL activity that leaves the cached provider snapshot unchanged does not rebuild Hub state, increment its revision, or request a current-provider refresh. The Hub page loads full provider state once and polls it only while a user-started refresh operation is in progress. While visible, it polls only the lightweight companion-status route every 5,000 ms so browser connect/disconnect changes do not leave the cards stale. Only the current CCSwitch provider owns a fixed 300,000 ms balance timer.

The sanitized `/v1/providers` catalog caches provider aliases, login metadata, and query descriptions for the lifetime of one repository snapshot. A changed repository snapshot invalidates that derived catalog immediately; repeated read-only requests do not redo hostname routing and metadata construction.

The Hub also caches its public provider array, selector map, and browser-permission Origin list for the lifetime of the corresponding provider revision or repository snapshot. Operation polling reuses the public array until a real Hub revision occurs, companion heartbeats reuse the Origin list until provider/template configuration changes, and `/v1/health` reads only provider count plus refresh activity instead of materializing the complete provider state. Host status uses the same lightweight summary and a direct companion-connected check.

Runtime status and current-provider usage cache files use same-directory atomic replacement. Repeated identical status writes are coalesced until the five-minute heartbeat, avoiding disk churn during a persistent identical error. A transient status or usage-cache file lock is treated as a diagnostics/cache failure: it is retried later and must not turn an otherwise successful live balance query into a provider error or terminate the host. `usageCacheError` reports the latest current-provider cache persistence failure when the status file remains writable.

CDP target isolation is fail-closed per target. The host connects only to a `page` target whose snapshot URL is exactly the canonical Codex main document, `app://-/index.html`, with no query or fragment. Immediately after each short-lived connection, the operation revalidates that the live renderer is still the top-level canonical document before reading or changing its title, injector, or payload; a target that navigated after the HTTP snapshot is rejected and closed. Every eligible target WebSocket exists only for that acknowledgement, inspection, injection, or update call and is closed in `finally`; a socket whose handshake times out or fails is closed before ownership can transfer to a client. Deferred audits remain pending but never accelerate the maintenance loop beyond the 1,000 ms page-action cadence. A persistent one-shot installation failure uses a target-keyed `1,000 / 2,000 / 5,000 / 10,000 / 30,000 ms` retry sequence; a replacement target or new page action bypasses the old target's delay. The host never calls browser-wide `Target.setDiscoverTargets`, never keeps a target session, and never calls `Runtime.enable` or `Runtime.addBinding`. Empty URLs, `about:blank`, external pages, Browser Use WebViews, MCP App guests, auxiliary `initialRoute` windows, and every `webview` or `iframe` target are excluded from the operation list. Their presence does not delay Hub actions, refreshes, payload updates, or main-page injector maintenance because no operation ever connects to them.

The launcher resolves the exact root `ChatGPT.exe` PID after CDP becomes ready and passes it to both the source-mode Node host and the packaged detached launcher. The host checks only that Windows process identity every 1,000 ms; it does not keep a CDP WebSocket open for lifecycle detection. When the root PID exits, the host runs its full shutdown path, closes the Hub listener, browser broker, CDP HTTP agent, file/database resources, removes `host.pid`, writes stopped status, and forces the Node process to exit after a bounded 750 ms cleanup window. Stopping or hot-reloading the host remains one-way and never stops ChatGPT.

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

The injector layout policy was verified against the live Codex App through CDP function coverage, using controls inside the mounted primary composer footer rather than similarly named controls from transient side-task surfaces. The current injector version is `91`; the exhaustive interaction baseline below was established with injector `69` on Codex Desktop `26.715.2305.0`. Update that baseline only after completing the corresponding full live regression.

| Codex interaction | Expected injector geometry work |
|---|---|
| Focus composer, type/delete one line, grow/shrink a multiline editor | No layout |
| Open attachment, access, search, task, or top application menus | No layout |
| Expand/collapse command results, scroll messages, jump to a message | No layout |
| Toggle the left sidebar, pinned summary, or bottom panel while the composer footer remains mounted | No layout; native flow moves the balance with the composer |
| Change the access label between Full Access and Agent Approval | No layout while the free-lane width and responsive mode remain unchanged |
| Open or close the animated model/reasoning menu | No layout when the current responsive mode and native trigger both fit; squeezed transient widths use an immediate layout plus one bounded 180 ms settle check to constrain or release the native trigger |
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
