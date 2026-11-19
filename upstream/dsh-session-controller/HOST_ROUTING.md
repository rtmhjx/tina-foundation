# Session-scoped host routing extension v1

This is a source overlay of `@deepseek-ai/dsh-api-session-controller@0.1.5-rc.2`,
not a bundle string patch and not a replacement AgentLoop. The baseline, source
origin, and original source hashes are recorded in `BASELINE.json`; the generated
bundle and modified source hashes are recorded in `BUILD.json`. The upstream MIT
license is retained in `LICENSE`.

The ordinary controller API and Remote RPC contract remain unchanged. No host
route or presentation is enabled by default. A compatible host exposes:

```ts
readonly hostRoutingVersion = 1
registerPromptRoute(sessionId, async ({ request, message, agent }) => {}): () => void
registerHistoryPresentation(sessionId, { event, stream, baseline }): () => void
```

Each lease is exclusive for its selected Session, and its disposer can release
only its own registration. Prompts in every other Session follow the original
controller behavior. The prompt hook runs after native model, input, and
attachment validation, immediately before native queue admission. Its successful
return consumes that prompt; failure rejects the RPC and does not enqueue it as
ordinary user text. Attachment receipt ownership commits only after success.

History presentation is used by the actual native `session.page` and
`session.follow` APIs. It returns exactly one wire event for each native event,
with the same sequence and time. It cannot remove a durable cursor. Raw Session
events, model history, storage, tool execution, and provenance remain unchanged.
Assistant live-frame and opening-baseline hooks also operate on those actual
native follow APIs. Disposing the lease restores ordinary native presentation.

`src/host-routing.mjs` installs the leases before bot startup. A held prompt waits
for `activate()`. Startup failure rejects held prompts. `prepareDispose()` first closes only input
admission and drains already-running delivery callbacks while keeping speech and
presentation available for the finishing owned turn; `dispose()` releases the
leases after the bot lifecycle has drained. A stable request identity
is recorded as `cortico/host-input` and flushed before delivery into World. A
successful World callback receives a separate flushed settlement receipt. RPC
retries with the same content are acknowledged without another World delivery;
changed content using the same RPC id is rejected. After a crash or callback
failure, an input without a settlement receipt fails closed as
`HOST_INPUT_UNSETTLED`. It is not automatically replayed across an ambiguous
delivery boundary. Exactly-once success is verified; ambiguous crash recovery
requires inspection of the durable World event id before deliberate repair.

World speech uses a distinct durable `cortico/host-world-speech` event, preserving
`id`, `sessionId`, `worldId`, `text`, `origin: 'world-action'`, and JSON provenance.
It does not impersonate a model message. The companion native client extension
renders this event as its own World speech bubble. Internal model completions
are retained in the raw log but replaced with opaque cursor-preserving events in
the owned native UI view. Durable lease spans retain this distinction after a
plugin remount. Prior RP history is never rewritten.

Build and verify an explicit host baseline:

```powershell
node scripts/build-host-compat.mjs
node scripts/install-host-compat.mjs --runtime=F:\isolated-dsh --plan
```

The installer defaults to verification. `--apply` backs up the original index
and source map before installing; `--rollback` restores their verified bytes.
It accepts only the exact reviewed package version and baseline bundle SHA,
or an explicitly recorded prior fusion source build, or the current reviewed
overlay SHA. Rollback restores whichever verified input this installation replaced.
The unified operation covers Session, Tools, AgentLoop, and Session Controller;
AgentLoop and Tools include their invariant entry points and shared chunks. Different DSH revisions require a source
port and fresh acceptance. Applying or rolling back files requires restarting
that selected host later; the installer never restarts a service. Development
acceptance applies this overlay only to `.test-runtime/dsh`, never an existing
DSH deployment or Tina server.
