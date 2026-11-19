import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const FUSION_RESULT_READ_TOOL = 'tina_result_read';
const PREFIX = 'fusion-result:';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const textBlocks = text => [{ type: 'text', text }];
const ownerOf = agent => agent?.session?.header?.id;
const int = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('RESULT_ARGUMENT', `Invalid ${name}.`);
  return value;
};
const identity = record => hash(JSON.stringify([record.sessionId, record.name, record.callId, record.label, record.sha256, record.bytes]));
const noLink = async path => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || relative(path, await realpath(path)) !== '') throw fail('RESULT_PATH', 'Redirected result storage is forbidden.');
  return info;
};

/** Reuses native spill-local naming/private writes; adds an immutable reference manifest. */
export async function openFusionToolResultStore({ stateDir, dataDir = join(stateDir, 'tool-results'), sessionId, nativeLocal, maxArtifactBytes = 32 * 1024 * 1024 }) {
  if (!isAbsolute(stateDir) || !sessionId || !nativeLocal?.saveTextFile) throw fail('RESULT_CONFIG', 'Result storage requires isolated state, session and native spill storage.');
  int(maxArtifactBytes, 1024, 1024 * 1024 * 1024, 'artifact limit');
  const state = resolve(stateDir), root = resolve(dataDir), rel = relative(state, root);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw fail('RESULT_PATH', 'Result storage must be inside isolated state.');
  await noLink(state);
  let at = state;
  for (const part of rel.split(sep)) {
    at = join(at, part); await mkdir(at, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await noLink(at)).isDirectory()) throw fail('RESULT_PATH', 'Result storage is not a directory.');
  }
  const manifests = join(root, 'references');
  await mkdir(manifests, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await noLink(manifests);
  async function readRecord(ref) {
    if (typeof ref !== 'string' || !/^fusion-result:[a-f0-9]{64}$/.test(ref)) throw fail('RESULT_REFERENCE', 'Invalid result reference.');
    await noLink(root); await noLink(manifests);
    const id = ref.slice(PREFIX.length), path = join(manifests, id + '.json');
    const stat = await noLink(path);
    if (!stat.isFile() || stat.size > 8192) throw fail('RESULT_IDENTITY', 'Result manifest is invalid.');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.version !== 1 || record.id !== id || record.sessionId !== sessionId || identity(record) !== id
      || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || record.bytes > maxArtifactBytes || !/^[a-f0-9]{12}-tool-result\.txt$/.test(record.file)) {
      throw fail('RESULT_IDENTITY', 'Result owner, digest or size does not match its reference.');
    }
    return record;
  }
  async function load(ref) {
    const record = await readRecord(ref);
    const dir = nativeLocal.sessionDir(root, sessionId);
    await noLink(dir);
    const path = join(dir, record.file);
    if (dirname(path) !== dir || basename(path) !== record.file) throw fail('RESULT_PATH', 'Invalid artifact path.');
    const before = await noLink(path);
    if (!before.isFile() || before.size !== record.bytes) throw fail('RESULT_IDENTITY', 'Result artifact size changed.');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const opened = await handle.stat();
      if (opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) throw fail('RESULT_IDENTITY', 'Result artifact identity changed.');
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('RESULT_IDENTITY', 'Result artifact changed while reading.');
    } finally { await handle.close(); }
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw fail('RESULT_IDENTITY', 'Result artifact digest changed.');
    return { record, bytes };
  }
  async function save({ name, callId, label = 'result', text }) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxArtifactBytes) throw fail('RESULT_OVERSIZE', 'Result exceeds the persistent projection limit; retain the original native result.');
    const record = { version: 1, sessionId, name, callId, label, sha256: hash(Buffer.from(text)), bytes };
    record.id = identity(record);
    const ref = PREFIX + record.id, manifest = join(manifests, record.id + '.json');
    try { await load(ref); return { ref, totalBytes: bytes, sha256: record.sha256 }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await noLink(root); await noLink(manifests);
    const dir = nativeLocal.sessionDir(root, sessionId);
    try { await noLink(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const saved = await nativeLocal.saveTextFile({ root, sessionId, suggestedName: 'tool-result.txt', content: text });
    await noLink(dir); await noLink(saved.path);
    if (dirname(saved.path) !== dir || saved.bytes !== bytes) throw fail('RESULT_IDENTITY', 'Native spill returned an unexpected artifact.');
    record.file = basename(saved.path);
    const handle = await open(manifest, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    // A reference is exposed only after both artifact and manifest are readable.
    await load(ref);
    return { ref, totalBytes: bytes, sha256: record.sha256 };
  }
  return { root, save, load, readRecord };
}

/** Session-scoped native post-policy. The original outer spill policy remains intact. */
export async function mountFusionToolResults(ctx, {
  sessionId, stateDir, dataDir, maxInlineBytes = 12000, maxPageBytes = 6000,
  maxArtifactBytes = 32 * 1024 * 1024, canReadSource,
}) {
  if (typeof canReadSource !== 'function') throw fail('RESULT_CONFIG', 'A current source authorization callback is required.');
  int(maxPageBytes, 256, 1024 * 1024, 'page limit');
  const [nativeLocal, retention] = await Promise.all([
    ctx.loader.import('@deepseek-ai/dsh-spill-local'), ctx.loader.import('@deepseek-ai/dsh-output-retention'),
  ]);
  const store = await openFusionToolResultStore({ stateDir, dataDir, sessionId, nativeLocal, maxArtifactBytes });
  const stats = { projected: 0, originalBytes: 0, inlineBytes: 0, reads: 0, deniedReads: 0, failures: 0, oversizeFallbacks: 0, mixedContentSkipped: 0, finalizerSkipped: 0 };
  const removers = [], bindings = new Map(), jobs = new Set();
  let closed = false, closing;
  const budget = () => {
    const value = typeof maxInlineBytes === 'function' ? maxInlineBytes() : maxInlineBytes;
    return value === null ? null : int(value, 1024, 1024 * 1024, 'inline limit');
  };
  budget();
  function track(operation) { const promise = Promise.resolve(operation); jobs.add(promise); void promise.finally(() => jobs.delete(promise)).catch(() => {}); return promise; }
  async function bound(exec, content, { name = exec.name, callId = exec.callId, label = 'result', isError = false } = {}) {
    const cap = budget();
    if (closed || cap === null || ownerOf(exec.agent) !== sessionId || exec.signal.aborted || name === FUSION_RESULT_READ_TOOL) return;
    if (!content.every(block => block.type === 'text')) { stats.mixedContentSkipped++; return; }
    const text = content.map(block => block.text).join('');
    const originalBytes = Buffer.byteLength(text, 'utf8');
    if (originalBytes <= cap) return;
    if (originalBytes > maxArtifactBytes) { stats.oversizeFallbacks++; return; }
    try {
      const ref = await store.save({ name, callId, label, text });
      if (exec.signal.aborted || closed) return;
      const base = { kind: 'tool-result-reference', ...ref, sourceTool: name, isError,
        readWith: FUSION_RESULT_READ_TOOL, offsetUnit: 'utf8-bytes' };
      let previewBudget = Math.max(0, cap - Buffer.byteLength(JSON.stringify({ ...base, preview: '' })) - 64);
      let projected;
      for (;;) {
        const retained = new retention.TextRetainer({ kind: 'headTail', headBytes: Math.ceil(previewBudget / 2), tailBytes: Math.floor(previewBudget / 2) });
        retained.push(text);
        projected = JSON.stringify({ ...base, preview: retained.finish().text });
        const bytes = Buffer.byteLength(projected);
        if (bytes <= cap) break;
        previewBudget = Math.max(0, previewBudget - (bytes - cap) - 32);
        if (!previewBudget) { projected = JSON.stringify(base); break; }
      }
      if (Buffer.byteLength(projected) > cap) return;
      stats.projected++; stats.originalBytes += originalBytes; stats.inlineBytes += Buffer.byteLength(projected);
      return textBlocks(projected);
    } catch (error) {
      stats.failures++;
      // Fail open to native spill, preserving the actual outcome and full text.
      ctx.logger.warn('Persistent tool-result projection unavailable; retaining native result (' + (error.code ?? 'RESULT_STORAGE') + ').');
    }
  }
  async function read(agent, args, signal = new AbortController().signal) {
    if (closed || ownerOf(agent) !== sessionId) throw fail('RESULT_OWNER', 'Result references belong only to the current session.');
    signal.throwIfAborted();
    const record = await store.readRecord(args.ref);
    if (await canReadSource({ agent, name: record.name, sessionId, callId: record.callId, ref: args.ref }) !== true) {
      stats.deniedReads++; throw fail('RESULT_SOURCE_DENIED', 'Reading the source tool result is forbidden by the current policy.');
    }
    signal.throwIfAborted();
    const { bytes } = await store.load(args.ref);
    const offset = int(args.offset ?? 0, 0, bytes.length, 'offset');
    if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw fail('RESULT_ARGUMENT', 'Offset must be a UTF-8 character boundary.');
    const limit = int(args.limit ?? maxPageBytes, 4, maxPageBytes, 'page length');
    const base = { ref: args.ref, totalBytes: record.bytes, sha256: record.sha256 };
    signal.throwIfAborted(); stats.reads++;
    if (args.query !== undefined) {
      if (typeof args.query !== 'string' || !args.query || Buffer.byteLength(args.query) > 256) throw fail('RESULT_ARGUMENT', 'Search requires a nonempty literal up to256 UTF-8 bytes.');
      const count = int(args.maxMatches ?? 8, 1, 20, 'match count');
      const body = bytes.subarray(offset).toString('utf8');
      const matches = []; let at = 0, nextOffset = offset, more = false;
      for (;;) {
        signal.throwIfAborted(); const found = body.indexOf(args.query, at); if (found < 0) break;
        if (matches.length >= count) { more = true; break; }
        const matchOffset = offset + Buffer.byteLength(body.slice(0, found));
        let end = Math.min(bytes.length, matchOffset + 256);
        while (end > matchOffset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        const item = { offset: matchOffset, text: bytes.subarray(matchOffset, end).toString('utf8') };
        if (Buffer.byteLength(JSON.stringify({ ...base, matches: [...matches, item] })) > limit && matches.length) { more = true; break; }
        matches.push(item); at = found + args.query.length; nextOffset = offset + Buffer.byteLength(body.slice(0, at));
      }
      return { ...base, matches, nextOffset, more, literal: true };
    }
    let end = Math.min(bytes.length, offset + limit);
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return { ...base, offset, nextOffset: end, text: bytes.subarray(offset, end).toString('utf8'), eof: end === bytes.length };
  }
  function attach(agent) {
    if (ownerOf(agent) !== sessionId || closed || bindings.has(agent)) return;
    const scope = agent.ctx;
    const owned = [scope.tools.register({ name: FUSION_RESULT_READ_TOOL,
      description: 'Read a persistent tool-result reference by UTF-8 byte offset/limit, or search with a literal query. Only current-session sources permitted by current policy are readable.',
      parameters: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, query: { type: 'string' }, maxMatches: { type: 'integer' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textBlocks(JSON.stringify(value)) },
      isConcurrencySafe: () => true, execute: (args, exec) => track(read(exec.agent, args, exec.signal)),
    })];
    // Not prepend: the native50KB outer policy sees our short decision.content.
    // Other sessions and nested program values retain their original policies.
    owned.push(scope.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.parent !== undefined) return decision;
      if (scope.tools.hasContentFinalizer(exec)) { stats.finalizerSkipped++; return decision; }
      const content = await track(bound(exec, decision.content ?? result.content, { isError: result.isError }));
      return content ? { ...decision, content } : decision;
    }));
    owned.push(scope.on('tools/ptc-dispatch-log', async (dispatch, next) => {
      const content = await next();
      if (dispatch.contentFinalized) { stats.finalizerSkipped++; return content; }
      return await track(bound(dispatch.exec, content, { name: dispatch.name, callId: dispatch.subCallId, label: 'dispatch', isError: dispatch.isError })) ?? content;
    }));
    bindings.set(agent, owned);
  }
  removers.push(ctx.on('agent/created', ({ agent }) => attach(agent)));
  removers.push(ctx.on('agent/disposed', ({ agent }) => { for (const remove of bindings.get(agent) ?? []) remove(); bindings.delete(agent); }));
  const current = ctx.agents.get(sessionId);
  if (current) attach(current);
  const dispose = () => closing ??= (async () => {
    closed = true; for (const remove of removers) remove();
    for (const owned of bindings.values()) for (const remove of owned) remove(); bindings.clear();
    await Promise.allSettled([...jobs]);
  })();
  ctx.effect(() => dispose);
  return { read, dispose, inspect: () => ({ ...stats, sessionId, dataDir: store.root, maxInlineBytes: budget(), maxPageBytes, maxArtifactBytes, closed }) };
}

export const name = 'fusion-tool-results';
export const inject = ['tools', 'agents', 'loader'];
export async function apply(ctx, config) { const handle = await mountFusionToolResults(ctx, config); ctx.provide('fusionToolResults', handle); }
