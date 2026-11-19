# Passive intake and native session archive

These source modules preserve the three live server helpers while removing the fixed deployment path. They do not submit model requests or replay World events.

Set `CORTICO_FUSION_STATE` to the selected deployment state. The explicit variable is required; importing these modules has no side effects.

```sh
export CORTICO_FUSION_STATE=/absolute/runtime/deployments/candidate
node /absolute/framework/ops/fusion-intake.mjs
node /absolute/framework/ops/fusion-session-archive.cjs
```

`fusion-intake.mjs` reads the existing `intake/collector.json`. Its existing `stateFile`, `cacheDir`, sources, endpoint, token environment variable and limits remain authoritative. `--catch-up` adjusts limits for that invocation without rewriting configuration. The existing Foundation source identity and append-only revision protocol are retained. Existing IDs are never overwritten; an origin mismatch is rejected. Source lookup keeps the local compatibility service at port 8895 by default.

`fusion-session-archive.cjs` continues loading the original legacy observer and appends new native journals beneath the same shared archive root. New workspace/session directories are added alongside old archives. It refuses source prefixes that rewrite already archived bytes. Capture receipts certify raw byte preservation, including incomplete open zstd frames; they do not certify successful decoding. `createObserver().scan()` supports deterministic checks; `start().stop()` owns only the new observer timer, not the unchanged legacy observer's lifetime.

| Variable | Default |
| --- | --- |
| `CORTICO_FUSION_STATE` | Required explicit deployment state |
| `CORTICO_TINA_RUNTIME` | Two directories above deployment state |
| `CORTICO_INTAKE_CONFIG` | `<state>/intake/collector.json` |
| `CORTICO_AGENT_INTAKE_MODULE` | `<runtime>/agent-intake/tina-memory-base/src/agent-intake.mjs` |
| `CORTICO_MEMORY_COMPAT_ORIGIN` | `http://127.0.0.1:8895` |
| `CORTICO_NATIVE_ARCHIVE` | `<runtime>/cortico-self/tina-main-native` |
| `CORTICO_LEGACY_ARCHIVE_MODULE` | `<runtime>/assembly/session-archive/tina-session-archive.js` |

The installed SelfMem compatibility helper remains `<state>/extensions/node_modules/@tina/self-mem/src/memorybase-compat.mjs`. No credentials are included here. An existing systemd service or timer can set the environment and invoke these modules; this source change alone does not modify any service.

The source baseline is the read-only server snapshot under `artifacts/server-source-baseline`, verified by the deployment owner against live file hashes. Historical source was not rewritten:

| Baseline | SHA-256 |
| --- | --- |
| `fusion-intake.mjs` | `fcf1f4f9065874e298d52f38d5c040639fbe79d9771c69b6312aa1a38cdaa109` |
| `fusion-intake-revisions.mjs` | `b45cf4a40de6c293a7d6ba25ed81f495090a1cc33fc942b628a4f3e592ca7916` |
| `fusion-session-archive.cjs` | `37b20d638058064fe16fb43291f59c295917256ffae197853f0e3b1b00ffc52f` |

Local verification: `node --test ops/fusion-ops.test.mjs`. The tests use temporary files and injected intake/legacy observer modules. They do not mount or run the production observer.
