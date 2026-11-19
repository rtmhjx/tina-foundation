import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const log = join(root, '.tina-fusion-dev', 'fusion4-root-tests-final.log');
await mkdir(join(root, '.tina-fusion-dev'), { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
const args = ['--expose-internals', '--import', './upstream/cortico/node_modules/tsx/dist/loader.mjs',
  '--test', '--test-concurrency=2', 'test/*.test.mjs'];
const output = createWriteStream(log);
const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
  TINA_TEST_DSH_ROOT: join(root, 'runtime', 'dsh-0.1.5-rc.2') }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
const code = await new Promise((resolveDone, reject) => { child.once('error', reject); child.once('close', resolveDone); });
await new Promise(resolveDone => output.end(resolveDone));
const bytes = await readFile(log), text = bytes.toString('utf8');
const count = label => Number(text.match(new RegExp('(?:ℹ|#) ' + label + ' (\\d+)'))?.[1] ?? NaN);
const files = ['package.json', 'src/fusion-app.mjs', 'src/fusion-world.mjs', 'src/fusion-tool-presentation.mjs',
  'src/fusion-tool-results.mjs', 'src/fusion-execution-policy.mjs', 'src/fusion-worker.mjs',
  'src/fusion-rp-policy.mjs', 'src/tina-controls.mjs', 'upstream/cortico/src/worlds/native-engine/webui/client.ts'];
const report = { productVersion: '0.2.0-fusion.4', status: code === 0 ? 'passed' : 'failed', exitCode: code,
  command: [process.execPath, ...args], requiredRuntimeExplicitlyEnabled: true,
  startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'),
  log, logSha256: createHash('sha256').update(bytes).digest('hex'),
  files: await Promise.all(files.map(async file => ({ file, sha256: createHash('sha256').update(await readFile(join(root, file))).digest('hex') }))) };
await writeFile(join(root, 'docs', 'FUSION4_ROOT_TEST_RESULT.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
process.exitCode = code;
