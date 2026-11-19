import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import paths from './paths.cjs';
import { revisionAwareIntake } from './fusion-intake-revisions.mjs';

/** One passive collection pass. The original cursor DB, cache and source identities are retained. */
export async function runIntake({ env = process.env, stateDir, catchUp = false, fetchImpl = globalThis.fetch,
  loadModule = file => import(pathToFileURL(file).href), log = console.log } = {}) {
  const resolved = paths.resolveOpsPaths({ env, stateDir });
  const config = JSON.parse(readFileSync(resolved.intakeConfig, 'utf8'));
  const directory = dirname(resolved.intakeConfig);
  if (catchUp) Object.assign(config, { maxRecords: 10000, maxRecordsPerFile: 10000 });
  const { createHttpIntake, createIntakeState, collectAgentSources } = await loadModule(resolved.intakeModule);
  const { foundationInput, foundationCanonical } = await loadModule(resolved.foundationModule);
  const token = config.tokenEnv ? env[config.tokenEnv] : undefined;
  if (config.tokenEnv && !token) throw new Error('Configured intake credential is absent');
  const cursor = createIntakeState(resolve(directory, config.stateFile));
  try {
    const sink = revisionAwareIntake(createHttpIntake({ endpoint: config.endpoint, token, timeoutMs: config.timeoutMs }), {
      foundationInput, foundationCanonical,
      async readSource(id) {
        const endpoint = new URL('/api/sources/' + encodeURIComponent(id), resolved.memoryCompatOrigin);
        const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(30000) });
        if (response.status !== 200) throw Object.assign(new Error('Intake source lookup failed'), { status: response.status });
        return (await response.json()).source;
      },
      async onRevision(row) { appendFileSync(join(directory, 'native-revisions.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 }); },
    });
    const report = await collectAgentSources({ ...config, state: cursor, cacheDir: resolve(directory, config.cacheDir),
      sources: (config.sources ?? []).map(source => ({ ...source,
        ...(source.root ? { root: resolve(directory, source.root) } : {}),
        ...(source.path ? { path: resolve(directory, source.path) } : {}),
      })), sink });
    const record = { at: new Date().toISOString(), ...report };
    appendFileSync(join(directory, 'runs.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    log(JSON.stringify({ at: record.at, added: report.added, processed: report.processed, readLines: report.readLines,
      sources: report.sources.length, errors: report.errors, unsupported: report.unsupported, budgetExhausted: report.budgetExhausted }));
    return record;
  } finally { cursor.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runIntake({ catchUp: process.argv.includes('--catch-up') });
  if (report.errors.length) process.exitCode = 1;
}
