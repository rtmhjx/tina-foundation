# Tools source compatibility component

The host plugin requires `hasContentFinalizer` from the reviewed fusion source in this directory.
`BASELINE.json` links the read-only local pinned source checkout and the previously
captured vendor baseline source lock, records the exact source-compiled upstream
entry SHA, and records the explicitly supported prior fusion build SHA. It does
not claim that every installation sharing the version string has identical bytes.
The older global npm DSH is unsupported and is rejected by the exact-baseline gate.

`BUILD.json` records the modified source hashes and every executable payload file.
The build first runs full-program TypeScript emit against the exact native peer
dependency anchor, then bundles its emitted JS main and invariant entries as one
entry family, retaining shared chunks. This is required to inline published
cross-module const enums such as Cordis FiberState; direct TypeScript bundling is
not a supported substitute. Rebuild with `--build-runtime=<reviewed DSH directory>`
when the development `.test-runtime/dsh` anchor is unavailable. The installer verifies all four components before mutation, saves
original or absent entry-family files, and restores their verified bytes on rollback.
No generated known-event catalog is loosened and no running service is restarted.

Use `scripts/build-host-compat.mjs` and `scripts/install-host-compat.mjs` at the
plugin root. Default installation action is the read-only `--plan`; both apply
and rollback require an explicit `--runtime=<isolated directory>` argument.
