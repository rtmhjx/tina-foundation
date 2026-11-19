import { mkdir, readFile, access, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

const queues = new Map();
const presetRoot = fileURLToPath(new URL('../docs/presets/', import.meta.url));
const guide = '记忆分层与升格说明书.md';
const seed = 'SEED-TAIL-PROACTIVE-GITMEM.md';
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const exists = path => access(path).then(() => true, () => false);
const chars = text => Array.from(text);
const lockKey = path => process.platform === 'win32' ? path.toLowerCase() : path;
function identity(value, name) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\\/\x00-\x1f]/.test(value) || value === '.' || value === '..')
    throw fail('INVALID_ID', `Invalid ${name}`);
  return value;
}
const normalizeLevel = (level = 'L1') => {
  const normalized = typeof level === 'string' ? level.trim().toUpperCase() : '';
  if (!/^L[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(Number(normalized.slice(1)))) throw fail('INVALID_LEVEL', 'Expected L1..Ln');
  return normalized;
};
const levelNumber = level => Number(normalizeLevel(level).slice(1));
const entryPath = id => `entries/${encodeURIComponent(identity(id, 'entry id'))}.md`;
const botPath = id => `bots/${encodeURIComponent(identity(id, 'botId'))}/记忆库.md`;
const opaqueId = (value, name) => {
  if (typeof value !== 'string' || !value.length) throw fail('INVALID_ID', `${name} must be nonempty text`);
  return value;
};
const normalizeRefs = refs => [...new Set(refs.map(ref => {
  if (typeof ref !== 'string') throw fail('INVALID_REF', 'Expected src:id, Lk:id, or bot:id');
  const trimmed = ref.trim();
  if (/^l[1-9]\d*:.+$/i.test(trimmed)) return 'L' + trimmed.slice(1);
  if (trimmed === 'guide') return `doc:${guide}`;
  if (!/^(src:.+|note:.+|L[1-9]\d*:.+|bot:.+|doc:记忆分层与升格说明书\.md)$/.test(trimmed)) throw fail('INVALID_REF', 'Expected src:id, note:id, Lk:id, or bot:id');
  return trimmed;
}))];
function serialize(entry) {
  const { content, ...metadata } = entry;
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${content}`;
}
function parse(text) {
  const end = text.indexOf('\n---\n', 4);
  if (!text.startsWith('---\n') || end < 0) throw fail('INVALID_ENTRY', 'Invalid GitMem Markdown header');
  return { ...JSON.parse(text.slice(4, end)), content: text.slice(end + 5) };
}
async function serial(key, work) {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(work);
  const tail = result.catch(() => {});
  queues.set(key, tail);
  try { return await result; } finally { if (queues.get(key) === tail) queues.delete(key); }
}
async function git(directory, args, { input, env = {} } = {}) {
  return new Promise((yes, no) => {
    const child = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', '-C', directory, ...args], {
      windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [], err = [];
    child.stdout.on('data', data => out.push(data)); child.stderr.on('data', data => err.push(data));
    child.on('error', no);
    child.on('close', code => code === 0 ? yes(Buffer.concat(out).toString('utf8'))
      : no(fail('GIT_ERROR', `git ${args[0]} (${code}): ${Buffer.concat(err).toString('utf8').trim()}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function sourcesDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sources(sourceId TEXT PRIMARY KEY, record TEXT NOT NULL, digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_state(authority TEXT PRIMARY KEY, localCursor INTEGER NOT NULL, remoteCursor INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS sources_immutable_update BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT,'immutable source'); END;
    CREATE TRIGGER IF NOT EXISTS sources_immutable_delete BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT,'immutable source'); END;`);
  return db;
}
function putSource(db, record) {
  const encoded = canonical(record), digest = hash(encoded);
  const result = db.prepare('INSERT OR IGNORE INTO sources(sourceId,record,digest) VALUES(?,?,?)').run(record.sourceId, encoded, digest);
  const stored = db.prepare('SELECT digest FROM sources WHERE sourceId=?').get(record.sourceId);
  if (stored.digest !== digest) throw fail('SOURCE_CONFLICT', `Immutable source differs: ${record.sourceId}`);
  return result.changes > 0;
}

/** P1/P2 storage and coordination only. No model calls, Persona replacement, or live-service hooks. */
export class SharedGitMem {
  constructor({ authorityDir, deviceDir, directory, presetsDir = presetRoot, syncIntervalMs = 1000 } = {}) {
    if (!authorityDir || !(deviceDir ?? directory)) throw new Error('authorityDir and deviceDir are required');
    this.authorityDir = resolve(authorityDir); this.deviceDir = resolve(deviceDir ?? directory);
    if (this.authorityDir === this.deviceDir) throw new Error('Authority and device directories must differ');
    this.presetsDir = resolve(presetsDir); this.syncIntervalMs = syncIntervalMs;
    this.workspacesDir = join(this.deviceDir, 'workspaces'); this.connections = new Map(); this.pending = new Set();
    this.closed = false; this.initializing = null; this.accepting = true; this.closing = null;
    this.calls = new AsyncLocalStorage();
    // Public reads and connection setup own native handles just as writes do.
    // Nested calls remain in the already admitted operation during shutdown.
    for (const method of ['init', 'connect', 'disconnect', 'readSource', 'listSources', 'listSourceRecords', 'syncSources', 'readBotEntry',
      'readSelfCanvas', 'lookupSelfCanvasOperation', 'readEntry', 'readRef', 'entries', 'botEntries', 'search', 'buildSystemPrefix']) {
      const invoke = this[method].bind(this);
      this[method] = (...args) => this._track(() => invoke(...args));
    }
  }
  _track(work) {
    const inherited = this.calls.getStore();
    if (inherited?.active) return Promise.resolve().then(work);
    if (!this.accepting || this.closed) return Promise.reject(fail('CLOSED', 'SharedGitMem is closing or closed'));
    const admitted = { active: true };
    const promise = this.calls.run(admitted, () => Promise.resolve().then(work));
    this.pending.add(promise);
    const finished = () => { admitted.active = false; this.pending.delete(promise); };
    promise.then(finished, finished);
    return promise;
  }
  async init({ botIds = [] } = {}) {
    if (this.closed) throw fail('CLOSED', 'SharedGitMem is closed');
    this.initializing ??= (async () => {
      await mkdir(this.authorityDir, { recursive: true }); await mkdir(this.workspacesDir, { recursive: true });
      this.raw = sourcesDb(join(this.deviceDir, 'sources.sqlite'));
      // SQLite holds only L0 and the cross-process transaction lock, never L prose or semantic indexes.
      this.authorityRaw = sourcesDb(join(this.authorityDir, 'sources.sqlite'));
      this.coordinator = new DatabaseSync(join(this.authorityDir, '.gitmem-coordination.sqlite'));
      this.coordinator.exec('PRAGMA busy_timeout=30000; CREATE TABLE IF NOT EXISTS mutex(id INTEGER PRIMARY KEY)');
      await this._authority(async () => {
        const repository = await exists(join(this.authorityDir, '.git'));
        if (repository && !(await this._show(this.authorityDir, 'HEAD', '.gitmem-format')))
          throw fail('FOREIGN_REPOSITORY', 'Refusing to initialize an unrelated Git repository');
        if (!repository) {
          const [instructions, tail] = await Promise.all([readFile(join(this.presetsDir, guide)), readFile(join(this.presetsDir, seed))]);
          await git(this.authorityDir, ['init', '-b', 'main']);
          await this._commit(new Map([
            ['.gitmem-format', 'shared-gitmem/1\n'], ['.gitignore', '/sources.sqlite*\n/.gitmem-coordination.sqlite*\n'],
            ['.gitattributes', '* -text\n'],
            [guide, instructions], [seed, tail],
          ]), 'Initialize shared GitMem', 'shared-gitmem');
        } else await this._materialize(await this._head());
      });
    })();
    await this.initializing;
    for (const botId of botIds) await this.sync(botId);
    return this;
  }
  async _authority(work) {
    return serial(`authority:${lockKey(this.authorityDir)}`, async () => {
      // A real transaction releases its lock on process exit. Same-process calls queue before BEGIN.
      this.coordinator.exec('BEGIN IMMEDIATE');
      try { const result = await work(); this.coordinator.exec('COMMIT'); return result; }
      catch (error) { this.coordinator.exec('ROLLBACK'); throw error; }
    });
  }
  async _head(directory = this.authorityDir) { return (await git(directory, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  async _revision(directory, rev = 'HEAD') {
    return (await git(directory, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
  }
  async _show(directory, rev, file) {
    try {
      const commit = /^[0-9a-f]{40}$/.test(rev) ? rev : await this._revision(directory, rev);
      return await git(directory, ['cat-file', 'blob', `${commit}:${file}`]);
    }
    catch (error) { if (error.code === 'GIT_ERROR' && /does not exist|Not a valid object|Needed a single revision|invalid object name|bad revision/.test(error.message)) return null; throw error; }
  }
  async _materialize(head) {
    await git(this.authorityDir, ['read-tree', '--reset', '-u', head]); this.materializedHead = head;
  }
  async _commit(changes, message, botId) {
    let parent; try { parent = await this._head(); } catch (error) { if (error.code !== 'GIT_ERROR') throw error; }
    const index = join(this.authorityDir, '.git', `lmem-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: botId, GIT_AUTHOR_EMAIL: 'memory@local.invalid',
      GIT_COMMITTER_NAME: 'SharedGitMem', GIT_COMMITTER_EMAIL: 'memory@local.invalid' };
    try {
      await git(this.authorityDir, ['read-tree', ...(parent ? [parent] : ['--empty'])], { env });
      for (const [file, bytes] of changes) {
        const object = (await git(this.authorityDir, ['hash-object', '-w', '--stdin'], { input: bytes, env })).trim();
        await git(this.authorityDir, ['update-index', '--add', '--cacheinfo', '100644', object, file], { env });
      }
      const tree = (await git(this.authorityDir, ['write-tree'], { env })).trim();
      const commit = (await git(this.authorityDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: message + '\n', env })).trim();
      await git(this.authorityDir, ['update-ref', 'refs/heads/main', commit, parent ?? '0'.repeat(40)]);
      await this._materialize(commit);
      return commit;
    } finally { await rm(index, { force: true }); await rm(index + '.lock', { force: true }); }
  }
  async _withBot(botId, work) {
    identity(botId, 'botId'); await this.init();
    const directory = join(this.workspacesDir, encodeURIComponent(botId));
    return serial(`workspace:${lockKey(directory)}`, async () => {
      if (!(await exists(join(directory, '.git')))) {
        await this._authority(async () => {
          if (!(await this._show(this.authorityDir, 'HEAD', botPath(botId)))) {
            let template;
            try { template = await readFile(join(this.presetsDir, '记忆库.template.md'), 'utf8'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; template = '# <位置id> 的记忆库\n\n关注的主题与进入共同库的 ref 写在这里。\n'; }
            await this._commit(new Map([[botPath(botId), template.replaceAll('<位置id>', botId)]]), `Register Bot ${botId}`, botId);
          }
          await git(this.workspacesDir, ['clone', '--no-hardlinks', this.authorityDir, directory]);
        });
      }
      return work(directory);
    });
  }
  _rawSync() {
    const cursor = this.raw.prepare('SELECT localCursor,remoteCursor FROM sync_state WHERE authority=?').get(this.authorityDir) ?? { localCursor: 0, remoteCursor: 0 };
    const localEnd = this.raw.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM sources').get().value;
    const remoteEnd = this.authorityRaw.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM sources').get().value;
    function* records(db, after, end) {
      const page = db.prepare('SELECT rowid,record FROM sources WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 64');
      while (after < end) {
        const rows = page.all(after, end);
        if (!rows.length) break;
        for (const row of rows) yield JSON.parse(row.record);
        after = rows.at(-1).rowid;
      }
    }
    // Check both directions before appending so an identity conflict never silently overwrites a source.
    for (const record of records(this.raw, cursor.localCursor, localEnd)) {
      const other = this.authorityRaw.prepare('SELECT digest FROM sources WHERE sourceId=?').get(record.sourceId);
      if (other && other.digest !== hash(canonical(record))) throw fail('SOURCE_CONFLICT', `Immutable source differs: ${record.sourceId}`);
    }
    for (const record of records(this.authorityRaw, cursor.remoteCursor, remoteEnd)) {
      const other = this.raw.prepare('SELECT digest FROM sources WHERE sourceId=?').get(record.sourceId);
      if (other && other.digest !== hash(canonical(record))) throw fail('SOURCE_CONFLICT', `Immutable source differs: ${record.sourceId}`);
    }
    let uploaded = 0, downloaded = 0;
    for (const record of records(this.raw, cursor.localCursor, localEnd)) if (putSource(this.authorityRaw, record)) uploaded++;
    for (const record of records(this.authorityRaw, cursor.remoteCursor, remoteEnd)) if (putSource(this.raw, record)) downloaded++;
    this.raw.prepare('INSERT INTO sync_state(authority,localCursor,remoteCursor) VALUES(?,?,?) ON CONFLICT(authority) DO UPDATE SET localCursor=excluded.localCursor,remoteCursor=excluded.remoteCursor')
      .run(this.authorityDir, Math.max(cursor.localCursor, localEnd), Math.max(cursor.remoteCursor, remoteEnd));
    return { uploaded, downloaded };
  }
  async _dirty(directory) { return Boolean((await git(directory, ['status', '--porcelain', '--untracked-files=all'])).trim()); }
  async _advance(directory, head = null) {
    head ??= await this._head();
    // Keep every clean sync inside the admitted advancement boundary, including
    // a no-op. Equal heads need neither network fetch nor destructive reset.
    if (await this._head(directory) === head) return head;
    await git(directory, ['fetch', '--quiet', 'origin', 'main']);
    await this._assertBaseline(directory, head);
    await git(directory, ['reset', '--hard', head]);
    return head;
  }
  async _assertBaseline(directory, head = null) {
    const local = await this._head(directory);
    // A clone may not yet have the newest objects. Verify ancestry in authority,
    // which contains every accepted base; private commits are absent or divergent.
    try { await git(this.authorityDir, ['merge-base', '--is-ancestor', local, head ?? await this._head()]); }
    catch { throw fail('WORKSPACE_DIVERGED', 'Workspace has private commits or authority history changed; reconcile explicitly before sync'); }
  }
  async _receipt(directory, receipt, commitId, replayed) {
    let workspaceUpdated = false, syncError;
    try {
      this._rawSync();
      await this._materialize(await this._head());
      if (!(await this._dirty(directory))) { await this._advance(directory); workspaceUpdated = true; }
    } catch (error) { syncError = { code: error.code, message: error.message }; }
    return { ...receipt, commitId, replayed, workspaceUpdated, ...(syncError ? { syncError } : {}) };
  }
  sync(botId) { return this._track(() => this._withBot(botId, directory => this._authority(async () => {
    const sources = this._rawSync(), authorityHead = await this._head();
    if (this.materializedHead !== authorityHead) await this._materialize(authorityHead);
    if (await this._dirty(directory)) return { botId, head: await this._head(directory), authorityHead, workspaceUpdated: false, dirty: true, ...sources };
    return { botId, head: await this._advance(directory, authorityHead), authorityHead, workspaceUpdated: true, ...sources };
  }))); }
  async connect(botId, { intervalMs = this.syncIntervalMs } = {}) {
    if (this.connections.has(botId)) return this.sync(botId);
    const connection = { error: null, timer: null, running: false };
    const initial = await this.sync(botId);
    if (!this.accepting || this.closed) return initial;
    if (intervalMs > 0) connection.timer = setInterval(() => {
      if (connection.running || !this.accepting || this.closed) return;
      connection.running = true;
      this.sync(botId).then(() => { connection.error = null; }, error => { connection.error = error; })
        .finally(() => { connection.running = false; });
    }, intervalMs);
    connection.timer?.unref(); this.connections.set(botId, connection); return initial;
  }
  async disconnect(botId) { clearInterval(this.connections.get(botId)?.timer); this.connections.delete(botId); }
  appendSource(record, { sync = true } = {}) { return this._track(async () => {
    await this.init(); opaqueId(record.sourceId, 'sourceId');
    if (typeof record.content !== 'string') throw fail('INVALID_SOURCE', 'Source content must be original text');
    putSource(this.raw, record);
    if (sync && this.connections.size) await this.sync(this.connections.keys().next().value);
    return this.readSource(record.sourceId);
  }); }
  appendSources(records, { sync = false } = {}) { return this._track(async () => {
    if (!Array.isArray(records) || records.length > 1000) throw fail('INVALID_SOURCE', 'Source batch must contain at most 1000 records');
    // Validate and detach before acquiring the write transaction. A conflict at
    // the end of the batch must leave no earlier sources partially published.
    const batch = records.map(record => {
      opaqueId(record?.sourceId, 'sourceId');
      if (typeof record.content !== 'string') throw fail('INVALID_SOURCE', 'Source content must be original text');
      return JSON.parse(canonical(record));
    });
    await this.init();
    let added = 0;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      for (const record of batch) if (putSource(this.raw, record)) added++;
      this.raw.exec('COMMIT');
    } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
    if (sync && this.connections.size) await this.sync(this.connections.keys().next().value);
    return { added, sourceIds: batch.map(record => record.sourceId) };
  }); }
  async readSource(sourceId) {
    await this.init(); const row = this.raw.prepare('SELECT record FROM sources WHERE sourceId=?').get(sourceId);
    if (!row) throw fail('SOURCE_NOT_FOUND', `Source not synchronized: ${sourceId}`);
    return JSON.parse(row.record);
  }
  async listSources() { await this.init(); return this.raw.prepare('SELECT record FROM sources ORDER BY rowid').all().map(row => JSON.parse(row.record)); }
  async syncSources() {
    await this.init();
    return this._authority(() => this._rawSync());
  }
  async listSourceRecords({ after = 0, limit = 1000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw fail('INVALID_CURSOR', 'after must be a nonnegative safe integer and limit must be 1..10000');
    await this.init();
    const rows = this.raw.prepare('SELECT rowid AS cursor,record,digest FROM sources WHERE rowid>? ORDER BY rowid LIMIT ?').all(after, limit + 1);
    const records = rows.slice(0, limit).map(row => ({ cursor: row.cursor, record: JSON.parse(row.record), digest: row.digest }));
    return { records, cursor: records.at(-1)?.cursor ?? after, hasMore: rows.length > limit };
  }
  async _operation(directory, { botId, operationId, digest, kind, id }, build) {
    const path = `.operations/${hash(operationId)}.json`;
    return this._authority(async () => {
      const previous = await this._show(this.authorityDir, 'HEAD', path);
      if (previous) {
        const receipt = JSON.parse(previous);
        if (receipt.digest !== digest) throw fail('OPERATION_CONFLICT', `operationId reused with different input: ${operationId}`);
        const commitId = (await git(this.authorityDir, ['log', '-1', '--format=%H', 'HEAD', '--', path])).trim();
        return this._receipt(directory, receipt, commitId, true);
      }
      await this._assertBaseline(directory);
      this._rawSync();
      const base = await this._head(directory);
      const { file, text, extraFiles = [], message, status = 'normal', result } = await build(base);
      const receipt = { botId, operationId, digest, kind, id, status,
        ...(result === undefined ? {} : { result }) };
      const fileMap = new Map([[file, text], ...extraFiles, [path, JSON.stringify(receipt, null, 2) + '\n']]);
      const commitId = await this._commit(fileMap, message || `${botId} ${operationId}: ${kind} ${id}`, botId);
      return this._receipt(directory, receipt, commitId, false);
    });
  }
  writeEntry(input) { return this._track(async () => {
    const { botId, content } = input;
    const level = normalizeLevel(input.level ?? 'L1');
    if (typeof content !== 'string') throw fail('INVALID_CONTENT', 'Entry content must be text');
    const operationId = input.operationId ?? randomUUID(); opaqueId(operationId, 'operationId');
    const id = input.id ?? `e-${hash(`${botId}\0${operationId}`).slice(0, 24)}`;
    const refs = input.refs === undefined ? null : normalizeRefs(input.refs);
    const metadataKeys = ['entryKind', 'reason', 'createdAt', 'previousText', 'newText'];
    const metadata = Object.fromEntries(metadataKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const digest = hash(canonical({ kind: 'entry', botId, id: input.id ?? null, level, title: input.title ?? null, content, refs, baseRev: input.baseRev ?? null,
      ...(Object.keys(metadata).length ? { metadata } : {}) }));
    return this._withBot(botId, directory => this._operation(directory, { botId, operationId, digest, kind: 'entry', id }, async base => {
      const requestedBase = input.baseRev ?? base;
      // Resolve symbolic refs in the caller's workspace, preserving HEAD and
      // named-ref semantics. Accepted commit objects may exist only at authority.
      const baselineCommit = /^[a-f0-9]{40}$/i.test(requestedBase) ? requestedBase : await this._revision(directory, requestedBase);
      const baseRev = await this._revision(this.authorityDir, baselineCommit);
      const file = entryPath(id), baselineText = await this._show(this.authorityDir, baseRev, file);
      const currentRev = await this._head();
      const currentText = await this._show(this.authorityDir, currentRev, file);
      const current = currentText ? parse(currentText) : null;
      const unverifiedRefs = (refs ?? current?.refs ?? []).filter(ref => ref.startsWith('src:') && !this.authorityRaw.prepare('SELECT 1 FROM sources WHERE sourceId=?').get(ref.slice(4)));
      const retainedMetadata = Object.fromEntries(metadataKeys.filter(key => current?.[key] !== undefined).map(key => [key, current[key]]));
      const proposed = { id, level, title: input.title ?? current?.title ?? id, content, refs: refs ?? current?.refs ?? [], updatedBy: botId, operationId, baseRev,
        ...retainedMetadata, ...metadata,
        ...(unverifiedRefs.length ? { unverifiedRefs } : {}) };
      let entry = { ...proposed, status: 'normal' };
      const sameBody = current && ['level', 'title', 'content', 'refs', ...metadataKeys].every(key => canonical(current[key]) === canonical(proposed[key]));
      if (currentText !== baselineText && currentText !== null && !sameBody) {
        const variants = current.variants ?? [current];
        const candidate = proposed;
        const all = [...variants, candidate];
        const unique = [...new Map(all.map(v => [hash(canonical(v)), v])).values()];
        entry = { ...proposed, status: 'unreconciled', refs: [...new Set(unique.flatMap(v => v.refs))], variants: unique,
          content: unique.map((v, i) => `### 未协调版本 ${i + 1} · ${v.updatedBy} · ${v.level}\n\n${v.content}`).join('\n\n') };
      }
      // Persist this entry's last change, not an unrelated repository HEAD
      // (for example a newly registered bot). Retried callers must receive the
      // same prior note version even after other files or this note change.
      const previousRev = currentText === null ? null
        : (await git(this.authorityDir, ['log', '-1', '--format=%H', currentRev, '--', file])).trim();
      return { file, text: serialize(entry), status: entry.status,
        result: { previousRev } };
    }));
  }); }
  writeBotEntry({ botId, operationId = randomUUID(), content }) { return this._track(async () => {
    if (typeof content !== 'string') throw fail('INVALID_CONTENT', 'Bot entry content must be text');
    opaqueId(operationId, 'operationId');
    const digest = hash(canonical({ kind: 'bot', botId, content }));
    return this._withBot(botId, directory => this._operation(directory, { botId, operationId, digest, kind: 'bot', id: botId }, async () =>
      ({ file: botPath(botId), text: content })));
  }); }
  async lookupSelfCanvasOperation({ botId, operationId, command }) {
    identity(botId, 'botId'); opaqueId(operationId, 'operationId');
    if (command === undefined) throw fail('COMMAND_REQUIRED', 'A normalized command is required for canvas operation lookup');
    await this.init();
    const digest = hash(canonical({ kind: 'self-canvas-command', botId, command }));
    const path = `.operations/${hash(operationId)}.json`;
    return this._authority(async () => {
      const previous = await this._show(this.authorityDir, 'HEAD', path);
      if (!previous) return null;
      const receipt = JSON.parse(previous);
      if (receipt.kind !== 'self-canvas' || receipt.botId !== botId || receipt.digest !== digest)
        throw fail('OPERATION_CONFLICT', `operationId reused with different input: ${operationId}`);
      const commitId = (await git(this.authorityDir, ['log', '-1', '--format=%H', 'HEAD', '--', path])).trim();
      return { ...receipt, commitId, replayed: true };
    });
  }
  writeSelfCanvas({ botId, operationId = randomUUID(), content, message = '', extraEntries = [], baseRev: requestedBase, command, result }) { return this._track(async () => {
    if (typeof content !== 'string') throw fail('INVALID_CONTENT', 'TINA_SELF.md content must be text');
    opaqueId(operationId, 'operationId');
    const digest = command === undefined
      ? hash(canonical({ kind: 'self-canvas', botId, content, extraEntries }))
      : hash(canonical({ kind: 'self-canvas-command', botId, command }));
    return this._withBot(botId, directory => this._operation(directory, { botId, operationId, digest, kind: 'self-canvas', id: 'TINA_SELF.md' }, async (base) => {
      // Compare the actual document read by the caller, not the whole repository
      // HEAD: other bots may commit unrelated notes without invalidating this patch.
      const baseRev = await this._revision(this.authorityDir, requestedBase ?? base);
      const currentRev = await this._head();
      const baselineText = await this._show(this.authorityDir, baseRev, 'TINA_SELF.md');
      const currentText = await this._show(this.authorityDir, currentRev, 'TINA_SELF.md');
      if (currentText !== baselineText) {
        throw Object.assign(fail('SELF_CANVAS_CONFLICT', 'TINA_SELF.md changed after it was read; reread and apply the patch again'),
          { baseRev, currentRev });
      }
      const extraFiles = [];
      for (const item of extraEntries) {
        const eid = identity(item.id, 'entry id');
        const refs = normalizeRefs(item.refs ?? []);
        const unverifiedRefs = refs.filter(ref => ref.startsWith('src:') && !this.authorityRaw.prepare('SELECT 1 FROM sources WHERE sourceId=?').get(ref.slice(4)));
        const entryObj = {
          id: eid,
          level: normalizeLevel(item.level ?? 'L1'),
          entryKind: item.entryKind ?? 'memo',
          title: item.title ?? eid,
          content: item.content,
          ...(item.previousText !== undefined ? { previousText: item.previousText } : {}),
          ...(item.newText !== undefined ? { newText: item.newText } : {}),
          ...(item.reason ? { reason: item.reason } : {}),
          refs,
          updatedBy: botId,
          operationId,
          baseRev,
          status: 'normal',
          createdAt: item.createdAt ?? new Date().toISOString(),
          ...(unverifiedRefs.length ? { unverifiedRefs } : {}),
        };
        extraFiles.push([entryPath(eid), serialize(entryObj)]);
      }
      return {
        file: 'TINA_SELF.md',
        text: content,
        extraFiles,
        message: message || `${botId}: update TINA_SELF.md`,
        result,
      };
    }));
  }); }
  async readSelfCanvas({ botId, rev = 'HEAD' } = {}) {
    await this.init();
    const read = async directory => {
      const commitId = await this._revision(directory, rev ?? 'HEAD');
      const content = await this._show(directory, commitId, 'TINA_SELF.md');
      return { content, rev: commitId, exists: content !== null };
    };
    return botId ? this._withBot(botId, read) : read(this.authorityDir);
  }
  async readBotEntry({ targetBotId, rev = 'HEAD' }) {
    await this.init(); const commitId = await this._revision(this.authorityDir, rev);
    const content = await this._show(this.authorityDir, commitId, botPath(targetBotId));
    if (content === null) throw fail('ENTRY_NOT_FOUND', 'Bot entry not found');
    return { botId: targetBotId, content, rev: commitId };
  }
  async readEntry({ id, rev, botId } = {}) {
    await this.init();
    const read = async directory => {
      const commitId = await this._revision(directory, rev ?? 'HEAD');
      const text = await this._show(directory, commitId, entryPath(id));
      if (text === null) throw fail('ENTRY_NOT_FOUND', `Entry not found: ${id}`);
      return { ...parse(text), rev: commitId };
    };
    return botId ? this._withBot(botId, read) : read(this.authorityDir);
  }
  async readRef({ ref, botId, rev, expand = false, depth = 1 }, visited = new Set()) {
    if (ref === 'guide' || ref === `doc:${guide}`) {
      await this.init();
      const read = async directory => {
        const commit = await this._revision(directory, rev ?? 'HEAD');
        const content = await this._show(directory, commit, guide);
        if (content === null) throw fail('ENTRY_NOT_FOUND', 'Shared memory guide not found');
        return { kind: 'guide', ref: `doc:${guide}`, title: guide, content, rev: commit };
      };
      return botId ? this._withBot(botId, read) : read(this.authorityDir);
    }
    if (ref === 'self' || ref === 'TINA_SELF.md') {
      const selfDoc = await this.readSelfCanvas({ botId, rev });
      if (!selfDoc.exists) throw fail('ENTRY_NOT_FOUND', 'TINA_SELF.md not initialized yet');
      return { kind: 'self', ref: 'TINA_SELF.md', title: 'TINA_SELF.md', content: selfDoc.content, rev: selfDoc.rev };
    }
    if (ref.startsWith('src:')) return this.readSource(ref.slice(4));
    if (ref.startsWith('bot:')) return this.readBotEntry({ targetBotId: ref.slice(4), rev });
    if (ref.startsWith('note:')) return this.readEntry({ id: ref.slice(5), botId, rev });
    const match = /^(L[1-9]\d*):(.+)$/.exec(ref);
    if (!match) throw fail('INVALID_REF', 'Unknown memory reference');
    const entry = await this.readEntry({ id: match[2], botId, rev });
    if (entry.level !== match[1]) entry.movedFromLevel = match[1];
    if (expand && depth > 0 && !visited.has(entry.id)) {
      const next = new Set(visited).add(entry.id);
      entry.children = await Promise.all(entry.refs.map(child => this.readRef({ ref: child, botId, rev: entry.rev, expand, depth: depth - 1 }, next)));
    }
    return entry;
  }
  history({limit=50,rev='HEAD',entriesOnly=false}={}) {return this._track(async()=>{
    await this.init();if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw fail('INVALID_LIMIT','Invalid history limit');
    const commit=await this._revision(this.authorityDir,rev);
    const text=await git(this.authorityDir,['log',`-${limit}`,'--format=%H%x00%aI%x00%s',commit,...(entriesOnly?['--','entries/']:[])]);
    return text.trim().split('\n').filter(Boolean).map(line=>{const [rev,timestamp,subject]=line.split('\0');return {rev,timestamp,subject};});
  });}
  async botEntries({rev='HEAD'}={}) {
    await this.init();const commit=await this._revision(this.authorityDir,rev);
    const paths=(await git(this.authorityDir,['ls-tree','-r','-z','--name-only',commit,'--','bots/'])).split('\0');
    return Promise.all(paths.filter(path=>/^bots\/[^/]+\/记忆库\.md$/.test(path)).map(async path=>{
      const botId=decodeURIComponent(path.split('/')[1]);
      return {kind:'bot',botId,ref:`bot:${botId}`,rev:commit,content:await this._show(this.authorityDir,commit,path)};
    }));
  }
  async entries({ botId, rev } = {}) {
    await this.init();
    const read = async directory => {
      const commit = await this._revision(directory, rev ?? 'HEAD');
      const paths = (await git(directory, ['ls-tree', '-r', '--name-only', commit, '--', 'entries/'])).trim().split('\n').filter(Boolean);
      const output = [];
      for (let at = 0; at < paths.length; at += 8) {
        output.push(...await Promise.all(paths.slice(at, at + 8).map(async path => ({ ...parse(await this._show(directory, commit, path)), rev: commit }))));
      }
      return output;
    };
    return botId ? this._withBot(botId, read) : read(this.authorityDir);
  }
  async search({ query = '', botId, limit = 20, includeSources = true, includeBots = true, includeReasoning = false, onlyReasoning = false } = {}) {
    if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 0) throw new Error('query must be text and limit a nonnegative integer');
    if (limit === 0) return [];
    await this.init();
    const needle = query.toLowerCase(), matches = text => text.toLowerCase().includes(needle);
    const excerpt = text => chars(text).slice(0, 240).join('');
    const read = async directory => {
      // L prose and Bot navigation come from one immutable Git snapshot. Search
      // never advances a known workspace or mistakes authority HEAD for its view.
      const rev = await this._revision(directory, 'HEAD');
      const paths = (await git(directory, ['ls-tree', '-r', '-z', '--name-only', rev, '--', 'entries/', ...(includeBots ? ['bots/'] : [])]))
        .split('\0').filter(Boolean);
      const results = [];
      for (const path of paths.filter(path => !onlyReasoning && path.startsWith('entries/'))) {
        const entry = parse(await this._show(directory, rev, path));
        if (matches(`${entry.title}\n${entry.content}\n${entry.refs.join(' ')}`)) results.push({
          kind: 'entry', id: entry.id, title: entry.title, level: entry.level, ref: `${entry.level}:${entry.id}`,
          status: entry.status, rev, excerpt: excerpt(entry.content),
        });
        if (results.length === limit) return results;
      }
      if (includeSources || onlyReasoning) {
        // Originals are independently immutable and may arrive before any L1
        // exists. Only this device's received L0 is searchable; no implicit pull.
        const rows = this.raw.prepare('SELECT record,digest FROM sources ORDER BY rowid').all();
        for (const row of rows) {
          const source = JSON.parse(row.record);
          const sourceKind = source.kind ?? 'conversation';
          const reasoning=typeof source.reasoning==='string'?source.reasoning:'';
          const reasoningMatch=!!reasoning&&matches(reasoning);
          if(onlyReasoning?!reasoningMatch:!matches(`${source.sourceId}\n${source.title ?? ''}\n${source.content}\n${source.role ?? ''}\n${sourceKind}`)&&!((includeReasoning||onlyReasoning)&&reasoningMatch))continue;
          results.push({ kind: 'source', sourceKind, sourceId: source.sourceId, ref: `src:${source.sourceId}`,
            title: source.title ?? `${sourceKind === 'handoff' ? '交接过渡参考' : '原文'} · ${source.sourceId}`, rev: null, digest: row.digest,
            derived: sourceKind === 'handoff', transitional: sourceKind === 'handoff',
            ...((includeReasoning||onlyReasoning)&&reasoning?{reasoningExcerpt:excerpt(reasoning),matchedReasoning:reasoningMatch}:{}),
            ...(source.role === undefined ? {} : { role: source.role }),
            ...(source.refs === undefined ? {} : { refs: source.refs }),
            excerpt: excerpt(source.content),
          });
          if (results.length === limit) return results;
        }
      }
      if (includeBots && !onlyReasoning) for (const path of paths) {
        const match = /^bots\/([^/]+)\/记忆库\.md$/.exec(path);
        if (!match) continue;
        const targetBotId = decodeURIComponent(match[1]);
        const content = await this._show(directory, rev, path);
        if (matches(`${targetBotId}\n${content}`)) results.push({ kind: 'bot', botId: targetBotId,
          title: `${targetBotId} · 记忆库`, ref: `bot:${targetBotId}`, rev, excerpt: excerpt(content) });
        if (results.length === limit) return results;
      }
      return results;
    };
    return botId ? this._withBot(botId, read) : read(this.authorityDir);
  }
  status(botId) { return this._track(() => this._withBot(botId, async directory => {
    const headCommit = await this._head(directory), entryFile = botPath(botId);
    if (await this._show(directory, headCommit, entryFile) === null) throw fail('ENTRY_NOT_FOUND', 'Bot entry not found');
    const paths = (await git(directory, ['ls-tree', '-r', '--name-only', headCommit, '--', 'entries/'])).trim().split('\n').filter(Boolean);
    return { headCommit, entryFile, sharedWriteVerified: true,
      sourceCount: this.raw.prepare('SELECT COUNT(*) AS n FROM sources').get().n, entryCount: paths.length,
      verificationScope: 'shared-gitmem-storage-contract', dirty: await this._dirty(directory) };
  })); }
  readGuide({ rev = 'HEAD' } = {}) { return this._track(async () => {
    await this.init(); const text = await this._show(this.authorityDir, rev, guide);
    if (text === null) throw fail('ENTRY_NOT_FOUND', 'Shared memory guide not found');
    return text;
  }); }
  rollbackWorkspace({ botId }) { return this._track(() => this._withBot(botId, async directory => {
    const head = await this._head(directory);
    await git(directory, ['reset', '--hard', head]);
    await git(directory, ['clean', '-fd']);
    return { botId, head };
  })); }
  async buildSystemPrefix({ botId, maxChars = 4000, rev: atRev } = {}) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error('maxChars must be a nonnegative integer');
    const entries = await this.entries({ botId, rev: atRev }), byId = new Map(entries.map(e => [e.id, e]));
    const entryRefs = e => e.refs.filter(ref => /^L\d+:/.test(ref)).map(ref => ref.slice(ref.indexOf(':') + 1));
    const referenced = new Set(entries.flatMap(entryRefs));
    const roots = entries.filter(e => !referenced.has(e.id));
    if (!roots.length) roots.push(...entries);
    roots.sort((a, b) => levelNumber(b.level) - levelNumber(a.level) || a.id.localeCompare(b.id));
    const selected = new Map();
    const descendants = root => {
      const found = new Map(), sources = new Set(), seen = new Set([root.id]);
      const walk = e => { for (const ref of e.refs) {
        if (ref.startsWith('src:')) sources.add(ref);
        else { const id = ref.slice(ref.indexOf(':') + 1); if (!seen.has(id) && byId.has(id)) { seen.add(id); found.set(id, byId.get(id)); walk(byId.get(id)); } }
      } }; walk(root); return { found, sources };
    };
    for (const root of roots) {
      selected.set(root.id, root);
      for (const child of descendants(root).found.values()) if (levelNumber(child.level) === levelNumber(root.level) - 1) selected.set(child.id, child);
    }
    const rev = entries[0]?.rev ?? atRev ?? await this._withBot(botId, directory => this._head(directory));
    const own = await this.readBotEntry({ targetBotId: botId, rev });
    let prefix = `共同记忆（冰山入口；按 ref 下钻原文与历史）\n\n位置 ${botId} 的关注入口：\n${chars(own.content).slice(0, Math.floor(maxChars / 4)).join('')}\n`;
    const room = Math.max(0, Math.floor((maxChars - chars(prefix).length) / Math.max(1, selected.size)));
    for (const entry of selected.values()) {
      const { found, sources } = descendants(entry), counts = new Map();
      for (const child of found.values()) counts.set(child.level, (counts.get(child.level) ?? 0) + 1);
      const linked = [...counts].map(([level, n]) => `${n} 条 ${level}`).join(', ');
      const header = `\n${entry.level} ${entry.title} (${entry.status})\n[下连 ${linked ? linked + ', ' : ''}${sources.size} 条原文 → ref: ${entry.level}:${entry.id}]\n直连：${entry.refs.join(', ')}\n`;
      prefix += header + chars(entry.content).slice(0, Math.max(0, room - chars(header).length)).join('') + '\n';
    }
    return chars(prefix).slice(0, maxChars).join('');
  }
  close() {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      for (const connection of this.connections.values()) clearInterval(connection.timer);
      this.connections.clear();
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await this.initializing?.catch(() => {});
      // A connect admitted before close may finish, but must not revive polling.
      for (const connection of this.connections.values()) clearInterval(connection.timer);
      this.connections.clear();
      const errors = [];
      for (const db of [this.raw, this.authorityRaw, this.coordinator]) {
        try { db?.close(); } catch (error) { errors.push(error); }
      }
      this.closed = true;
      if (errors.length) throw new AggregateError(errors, 'SharedGitMem handle cleanup failed');
    })();
    return this.closing;
  }
}

const tool = (name, description, parameters, execute) => ({ name, description, parameters,
  tags: [name === 'lmem_write' ? 'write' : 'read'], execute,
  handler: async input => JSON.stringify(await execute(input)),
});
export function lmem_search(memory, { botId } = {}) {
  return tool('lmem_search', '检索共同 L 条目、本设备已同步原文及各位置入口，返回 ref 与版本；handoff 会标为过渡参考。', { type: 'object', properties: {
    query: { type: 'string' }, limit: { type: 'integer', minimum: 0 }, includeSources: { type: 'boolean', default: true }, includeBots: { type: 'boolean', default: true },includeReasoning:{type:'boolean',default:false},onlyReasoning:{type:'boolean',default:false},
  } },
    input => memory.search({ ...input, botId }));
}
export function lmem_read(memory, { botId } = {}) {
  return tool('lmem_read', '按 ref 读取条目、原文或其他位置入口；guide 或 doc:记忆分层与升格说明书.md 读取分层说明；expand 可展开引用。', { type: 'object', properties: { ref: { type: 'string' }, rev: { type: 'string' }, expand: { type: 'boolean' }, depth: { type: 'integer' } }, required: ['ref'] },
    input => memory.readRef({ ...input, botId }));
}
export function lmem_write(memory, { botId } = {}) {
  return tool('lmem_write', '维护 L1..Ln 或本位置入口；baseRev 指明实际读取依据，operationId 支持幂等重试。', { type: 'object', properties: {
    id: { type: 'string' }, title: { type: 'string' }, level: { type: 'string' }, content: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } },
    operationId: { type: 'string' }, baseRev: { type: 'string' }, target: { enum: ['entry', 'bot'] },
  }, required: ['content'] }, input => input.target === 'bot' ? memory.writeBotEntry({ ...input, botId }) : memory.writeEntry({ ...input, botId }));
}
export function createGitMemTools(memory, options) { return [lmem_search(memory, options), lmem_read(memory, options), lmem_write(memory, options)]; }
