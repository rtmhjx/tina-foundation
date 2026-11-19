'use strict';
// Passive byte archive. No model call, event replay or compressed-log repair.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveOpsPaths } = require('./paths.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function capture(source, destination) {
  const before = fs.statSync(source), input = fs.readFileSync(source), after = fs.statSync(source);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || input.length !== after.size) return { pending: true };
  const previous = fs.existsSync(destination) ? fs.readFileSync(destination) : Buffer.alloc(0);
  if (previous.length > input.length || !input.subarray(0, previous.length).equals(previous)) throw new Error('NATIVE_ARCHIVE_PREFIX_CHANGED');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const delta = input.subarray(previous.length), fd = fs.openSync(destination, 'a', 0o600);
  try { if (delta.length) fs.writeFileSync(fd, delta); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (!fs.readFileSync(destination).equals(input)) throw new Error('NATIVE_ARCHIVE_READBACK_FAILED');
  // Open journals may end mid-frame. This receipt certifies bytes, not decoding.
  const receipt = { at: new Date().toISOString(), source, from: previous.length, to: input.length,
    bytes: delta.length, sha256: sha(input), format: 'dsh-v3-zstd-raw-prefix', completeFrameChecked: false, reconciled: delta.length === 0 };
  const log = fs.openSync(path.join(path.dirname(destination), 'capture-manifest.jsonl'), 'a', 0o600);
  try { fs.writeFileSync(log, JSON.stringify(receipt) + '\n'); fs.fsyncSync(log); }
  finally { fs.closeSync(log); }
  return receipt;
}

function createObserver({ env = process.env, stateDir, onError = error => console.error('Fusion archive failed:', error.code || error.message) } = {}) {
  const resolved = resolveOpsPaths({ env, stateDir });
  const stable = new Map(), completed = new Map();
  function scan() {
    try {
      if (!fs.existsSync(resolved.nativeRoot)) return [];
      const receipts = [];
      for (const workspace of fs.readdirSync(resolved.nativeRoot, { withFileTypes: true })) {
        if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue;
        for (const session of fs.readdirSync(path.join(resolved.nativeRoot, workspace.name), { withFileTypes: true })) {
          if (!session.isDirectory() || session.isSymbolicLink()) continue;
          const source = path.join(resolved.nativeRoot, workspace.name, session.name, 'session.v3.jsonl.zstd');
          if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) continue;
          const stat = fs.statSync(source), signature = stat.ino + ':' + stat.size + ':' + stat.mtimeMs;
          if (completed.get(source) === signature) continue;
          if (stable.get(source) !== signature) { stable.set(source, signature); continue; }
          const result = capture(source, path.join(resolved.nativeArchive, workspace.name, session.name, 'session.v3.jsonl.zstd'));
          if (!result.pending) completed.set(source, signature);
          receipts.push(result);
        }
      }
      return receipts;
    } catch (error) { onError(error); return []; }
  }
  return { scan, paths: resolved };
}

function start(options = {}) {
  const observer = createObserver(options);
  // Load the original old-session observer unchanged; it keeps its own ownership.
  (options.loadLegacyObserver || require)(observer.paths.legacyObserver);
  const timer = setInterval(observer.scan, options.intervalMs ?? 3000);
  return { ...observer, stop: () => clearInterval(timer) };
}

module.exports = { capture, createObserver, start };
if (require.main === module) start();
