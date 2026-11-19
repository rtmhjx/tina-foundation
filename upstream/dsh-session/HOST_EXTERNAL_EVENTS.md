# External informational event producer v1

This source extension adds `Session.externalEventVersion === 1` and
`Session.appendExternal(type, data)` to the pinned Session package. Baseline and
source provenance are recorded in `BASELINE.json`; generated artifact and source
hashes are recorded in `BUILD.json`.

The producer accepts a namespaced type outside the native generated known-event
catalog. It appends a model-invisible informational record with explicit
`ignorable: true`, using the same snapshot, validation, freeze, publication,
sequence, and observer-isolation path as ordinary `append`. It rejects known
native event names, so callers cannot mark model history or state transitions
as omission-safe accidentally. Ordinary `append`, the native event vocabulary,
the native surface, and the Session format version retain their behavior.

This extension is needed because the pinned public `Session.append` does not
expose an envelope option for `ignorable`, while native persistence correctly
refuses to reload unknown required events. Changing the known-event catalog or
loosening persistence validation would make compatibility depend on which
plugins are mounted. Explicit stored omission safety retains compatibility
with an unmodified reader after plugin removal. These custom records describe
plugin input receipts, UI speech provenance, and presentation intervals; they
do not modify the native model surface or reconstruct the model's hidden state.

`test/host-routing.test.mjs` exercises the actual native persistence validator:
the new producer survives validation and Session recreation, whereas an unknown
ordinary `append` is refused. The source installer accepts the exact pinned
bundle SHA only and backs up the baseline before applying this extension.

Use the unified scripts from the plugin package root:

```powershell
node scripts/build-host-compat.mjs
node scripts/install-host-compat.mjs --runtime=F:\isolated-dsh --plan
node scripts/install-host-compat.mjs --runtime=F:\isolated-dsh --apply
node scripts/install-host-compat.mjs --runtime=F:\isolated-dsh --rollback
```

The plan checks all four components before any mutation: Session, Tools,
AgentLoop, and Session Controller. Apply follows that order; rollback reverses it.
AgentLoop supplies lifecycle-owned request heads; Tools supplies content-finalizer
ownership, including nested PTC executions. Their invariant entry points and
shared executable chunks are installed and restored with their main entries. A failed operation
attempts to reverse only changes it made, preserving components that were
already installed when the operation began. It never changes user profiles,
credentials, existing sessions, or running services. The main plugin carries
the browser contribution through its own `dsh.client` manifest; installing the
compatibility overlays alone does not mount the Persona or change its UI.
