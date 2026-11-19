Owner: `src/world.mjs`.

# Windows Codex Bridge

This private World API 6 package provides `codexbridge_health`, `codexbridge_submit` and `codexbridge_status`, and emits `codexbridge.result`. It calls the companion Windows worker directly over an existing, host-key-verified SSH connection. The worker executes `codex exec --json` and persists job state and an event outbox.

The Windows runtime, installation scripts, tests, deployment notes and operational limits are in the parent `codex-bridge-world` delivery. The package assumes the specific Tina and Windows hosts described there; installing this World alone does not install the worker or establish SSH trust.
