# CodexCCSwitchUsage workspace instructions

## Mandatory first steps

- Do not invoke or use any Superpowers skill or workflow in this repository unless the user explicitly asks for it.
- Before changing code, read [DEVELOPMENT.md](./DEVELOPMENT.md) completely.
- Treat `D:\software\CodexCCSwitchUsage` as the only source of truth.
- Do not edit generated files under `build\` or `dist\`.
- Do not edit the installed copy under `D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage`; deployment and packaging overwrite it.
- Development changes and performance optimizations must be applied as a hot update. Keep the existing Codex/ChatGPT application open and keep its root `ChatGPT.exe` PID unchanged.
- Development work must remain in workspace hot-update mode until the user explicitly confirms that the result may be packaged as an EXE. Do not run `npm run build:exe`, rebuild the launcher/installer, install an updated EXE, or replace the stable installation without that explicit confirmation.

## Project purpose

This Windows-only local extension reads the active CCSwitch Codex provider and its `usage_script`, queries the provider quota endpoint, and injects the result into the Codex composer footer through Chrome DevTools Protocol (CDP).

It deliberately does not modify Codex `app.asar`, MSIX files, or Codex configuration. Codex must be started with remote debugging enabled on port `9334`.

## Current operating modes

- Development source: `D:\software\CodexCCSwitchUsage`
- Current stable EXE installation: `D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage`
- Installer output: `D:\software\CodexCCSwitchUsage\dist\CodexCCSwitchUsage-Setup-<version>.exe`
- CCSwitch database: `%USERPROFILE%\.cc-switch\cc-switch.db`

Only one plugin host should run at a time. During development, do not click the installed desktop/start-menu EXE shortcut because it can start the stable host again.

## Safe commands

Run all commands from the workspace root.

Enter or reload development mode without closing Codex:

```powershell
$root = (Resolve-Path '.').Path
& .\scripts\stop-host.ps1 -InstallRoot $root -AllInstances
& .\scripts\launch.ps1 -InstallRoot $root
```

Run tests:

```powershell
npm test
```

Return to the installed stable EXE:

```powershell
$root = (Resolve-Path '.').Path
& .\scripts\stop-host.ps1 -InstallRoot $root -AllInstances
& 'D:\software\CodexCCSwitchUsageApp\CodexCCSwitchUsage\CodexCCSwitchUsage.exe'
```

Build a versioned installer after tests pass:

```powershell
npm run build:exe
```

This command is approval-gated. It may be run only after the user explicitly confirms that the current development result is ready to package as an EXE.

## Critical safety rules

- Use `scripts\stop-host.ps1` during development. It stops only plugin Node hosts.
- Do not use `scripts\stop.ps1` for ordinary reloads: it also terminates the Codex process tree.
- Never close, restart, or terminate `ChatGPT.exe` as part of a normal development reload. Restart only the plugin Node host, then hot-replace the injector in the existing page.
- If the existing Codex process is not listening on CDP port `9334`, do not restart it automatically during development. Report that hot update is unavailable and ask the user before any Codex restart.
- Do not run `scripts\uninstall.ps1` against the EXE-installed version. Remove the EXE version through Windows “Installed apps” or its `unins000.exe`.
- Never delete either `runtime\` directory during an update unless the user explicitly requests cache/state removal.
- Never patch Codex `app.asar`, preload files, or MSIX contents for this project.
- Preserve CCSwitch database read-only behavior and never log API keys or bearer tokens.
- Passing tests or completing a development task is not packaging approval. Wait for an explicit user instruction to build/package the EXE.

## Version rules

- `package.json` `version` controls the generated installer version and filename.
- Any change to injected UI/CSS/DOM/event behavior in `src\injector-script.mjs` must increment `INJECTOR_VERSION` so an already-open Codex page replaces the old injector.
- Host-only, repository, request, or launcher changes do not require an injector version bump.
- The balance UI must remain centered in the dynamic free lane between the left composer controls and the native right-side controls in every responsive mode. Keep the root container spanning that entire lane; compression may hide fields inside it but must not shrink or right-align the root itself.

## Required verification

Before claiming completion:

1. Run `npm test`.
2. For runtime changes, stop all plugin hosts and start the workspace version.
3. Confirm the Codex/ChatGPT root PID is identical before and after the reload.
4. Confirm `runtime\status.json` reports `running: true`, `connectedPages >= 1`, and no `connectionError`.
5. For injector changes, confirm the page reports the new injector version and the root remains mounted.
6. For packaging changes, run `npm run build:exe` and perform an isolated silent install/upgrade/uninstall smoke test without changing the running Codex PID.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full workflow and file map.
