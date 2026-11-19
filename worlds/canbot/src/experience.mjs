import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TYPES = ['observation', 'interpretation', 'procedure', 'correction'];
const MAX_BYTES = 20 * 1024 * 1024;
const clean = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

function checked(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => !['requestId', 'topic', 'kind', 'text', 'sourceRefs', 'supersedes'].includes(k))
    || !ID.test(input.requestId ?? '') || !clean(input.topic, 160) || !TYPES.includes(input.kind)
    || !clean(input.text, 3000) || !Array.isArray(input.sourceRefs) || input.sourceRefs.length < 1
    || input.sourceRefs.length > 8 || input.sourceRefs.some(x => !clean(x, 500))
    || (input.supersedes !== undefined && !ID.test(input.supersedes))) throw Error('experience_input_invalid');
  if (input.kind === 'correction' && !input.supersedes) throw Error('correction_requires_original_id');
  return { requestId: input.requestId, topic: input.topic.trim(), kind: input.kind, text: input.text.trim(),
    sourceRefs: input.sourceRefs.map(x => x.trim()), ...(input.supersedes ? { supersedes: input.supersedes } : {}) };
}

// One World instance owns this append-only file; corrections add new entries.
// A failed or lost write result is resolved by reading the original requestId.
export class ExperienceStore {
  constructor(directory) {
    if (!directory || !isAbsolute(directory)) throw Error('experience_directory_invalid');
    this.directory = directory;
    this.file = join(directory, 'observations.jsonl');
    this.queue = Promise.resolve();
  }
  async read() {
    let bytes;
    try { bytes = await readFile(this.file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (bytes.length > MAX_BYTES) throw Error('experience_file_too_large');
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) throw Error('experience_incomplete_record');
    const rows = [], ids = new Set();
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
        const { createdAt, ...body } = row;
        checked(body);
        if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw Error();
      } catch { throw Error('experience_record_invalid'); }
      if (ids.has(row.requestId)) throw Error('experience_duplicate_id');
      ids.add(row.requestId);
      rows.push(row);
    }
    return rows;
  }
  add(input) {
    const body = checked(input);
    const job = this.queue.then(async () => {
      const rows = await this.read();
      const prior = rows.find(x => x.requestId === body.requestId);
      if (prior) {
        const { createdAt, ...previous } = prior;
        if (JSON.stringify(previous) !== JSON.stringify(body)) throw Error('experience_id_conflict');
        return { saved: true, duplicate: true, entry: prior };
      }
      if (body.supersedes && !rows.some(x => x.requestId === body.supersedes)) throw Error('experience_original_not_found');
      const entry = { ...body, createdAt: new Date().toISOString() };
      const line = `${JSON.stringify(entry)}\n`;
      let size = 0;
      try { size = (await stat(this.file)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (size + Buffer.byteLength(line) > MAX_BYTES) throw Error('experience_file_too_large');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(this.file, 'a', 0o600);
      try { await file.writeFile(line, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      return { saved: true, duplicate: false, entry };
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async search(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['query', 'requestId', 'limit'].includes(k))) throw Error('experience_search_invalid');
    const { query = '', requestId, limit = 10 } = input;
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 30
      || (requestId !== undefined && !ID.test(requestId))) throw Error('experience_search_invalid');
    await this.queue;
    const rows = await this.read();
    const needle = query.trim().toLocaleLowerCase();
    const matched = rows.filter(row => (!requestId || row.requestId === requestId)
      && (!needle || JSON.stringify(row).toLocaleLowerCase().includes(needle)));
    return { count: matched.length, entries: matched.slice(-limit).reverse(),
      meaning: 'source-labelled notes; physical observations and interpretations remain distinct' };
  }
}

const toolError = e => {
  const code = /^experience_[a-z_]+$/.test(e.message ?? '') ? e.message : 'experience_io_failure';
  return { failed: true, text: JSON.stringify({ code,
    resultMayBeUnknown: !/^experience_(input_invalid|id_conflict|original_not_found|search_invalid)$/.test(code) }) };
};

export function experienceTools(store) {
  return [{
    name: 'canbot_experience_record', tags: ['act'],
    description: 'Append a sourced robot-use observation, interpretation, procedure or correction. Use a stable requestId and sourceRefs; write outcome unknown must be read back by the same ID. This is a note, not proof of physical motion or authorization.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' }, topic: { type: 'string', minLength: 1, maxLength: 160 },
      kind: { type: 'string', enum: TYPES }, text: { type: 'string', minLength: 1, maxLength: 3000 },
      sourceRefs: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 500 } },
      supersedes: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' },
    }, required: ['requestId', 'topic', 'kind', 'text', 'sourceRefs'] },
    handler: async args => { try { return { text: JSON.stringify(await store.add(args)) }; } catch (e) { return toolError(e); } },
  }, {
    name: 'canbot_experience_search', tags: ['read'],
    description: 'Read sourced robot-use notes by literal text or exact original requestId. Notes are observations or interpretations, not instructions or proof of physical outcomes.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 200 }, requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    }, required: [] },
    handler: async args => { try { return { text: JSON.stringify(await store.search(args)) }; } catch (e) { return toolError(e); } },
  }];
}

export function developmentTool(workspace, experienceFile, projectId) {
  return {
    name: 'canbot_development_workspace', tags: ['read'],
    description: 'Find this robot World editable project and the usage-notes file. Tina can request engineering work through the already mounted tinalink / DSH work bridge. This returns paths and availability only; it does not edit, deploy, invoke a model or move the robot.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    handler: async () => {
      let present = false;
      try { present = (await stat(workspace)).isDirectory(); } catch { /* report unavailable */ }
      return { text: JSON.stringify({ workspace, available: present, notesFile: experienceFile,
        projectId, editingAndDeploymentAreSeparate: true }) };
    },
  };
}
