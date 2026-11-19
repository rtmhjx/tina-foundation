Owner: `src/index.ts`, `scripts/build-dsh-file-upload.mjs`, and `vendor/dsh-file-upload-source-lock.json`.

This source fork fixes the host FileUploads resolver registration lifecycle. Cordis traces function-valued service properties through caller-scoped proxies, so a disposer cannot compare a retrieved function property with the original callback. The host stores a registration object and compares that object on disposal. The public resolver API is unchanged.

The baseline is the source and installed package recorded in `vendor/dsh-file-upload-baseline-lock.json`. Both original source and runtime payloads are archived before the overlay is applied. The source checkout was clean for this package at the time of capture; the surrounding DSH installation is an installed built-package closure, not a clean whole-repository source build.

Run `node scripts/build-dsh-file-upload.mjs` from the product root. TypeScript emits the four host source files and their declarations, and esbuild bundles the emitted host entry. Dependencies resolve through this package's locked independent runtime closure; the compiler and bundler come from the independent Cortico installation. No generated JavaScript is string-patched.

This is a **host source overlay**, not a rebuild of every package entry. The three browser source files are retained for provenance. The original browser bundle, Typert-generated host/remote entrypoints, and other untouched runtime files remain byte-identical to the locked baseline. The overlay changes no public protocol or browser API. The source lock records exactly which runtime files were rebuilt and which files were retained from the baseline.
