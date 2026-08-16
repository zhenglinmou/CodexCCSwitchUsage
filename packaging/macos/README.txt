Codex CCSwitch Usage macOS

Release ZIP bundles are Developer ID signed, Apple-notarized, stapled, and archived with ditto so macOS metadata is preserved. Private tar.gz builds made with -AllowUnsigned are not release artifacts.
Before launching it, start Codex with a random loopback-only CDP port:

  CDP_PORT=$((49152 + RANDOM % 16384))
  open -a "Codex" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" --remote-allow-origins="http://127.0.0.1:$CDP_PORT" --no-first-run

Then open CodexCCSwitchUsage.app. The writable runtime state is stored under:

  ~/Library/Application Support/CodexCCSwitchUsage/runtime

The CCSwitch database remains read-only at ~/.cc-switch/cc-switch.db.
The launcher discovers the port from the running Codex root process. If the application is not named "Codex" or the root PID cannot be detected, run the bundled executable from Terminal with --codex-pid <PID>.
Use Contents/Resources/stop-host.command to stop only the plugin host.
