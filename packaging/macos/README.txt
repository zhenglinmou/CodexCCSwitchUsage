Codex CCSwitch Usage macOS

This bundle is unsigned and is provided separately for Apple Silicon (arm64) and Intel (x64).
Before launching it, start Codex with local CDP port 9334:

  open -a "Codex" --args --remote-debugging-port=9334 --remote-allow-origins=http://127.0.0.1:9334 --no-first-run

Then open CodexCCSwitchUsage.app. The writable runtime state is stored under:

  ~/Library/Application Support/CodexCCSwitchUsage/runtime

The CCSwitch database remains read-only at ~/.cc-switch/cc-switch.db.
If the Codex application is not named "Codex" or the root PID cannot be detected, run the bundled executable from Terminal with --codex-pid <PID>.
Use Contents/Resources/stop-host.command to stop only the plugin host.
