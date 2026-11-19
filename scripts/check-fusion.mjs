import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(join(root,'package.json')));
const revision = version.match(/fusion\.(\d+)$/)?.[1];
if (!revision) throw new Error('A versioned fusion build is required.');
const stamp = new Date().toISOString().replace(/[^0-9]/g,'');
const log = join(root,'.tina-fusion-dev','fusion'+revision+'-root-'+stamp+'.log');
await mkdir(join(root,'.tina-fusion-dev'),{recursive:true});
const startedAt = new Date().toISOString(), started=performance.now();
const concurrency=Number(process.env.TINA_TEST_CONCURRENCY??1);
if(![1,2].includes(concurrency))throw new Error('Use one or two root test workers.');
const args=['--expose-internals','--import','./upstream/cortico/node_modules/tsx/dist/loader.mjs','--test','--test-concurrency='+concurrency,'test/*.test.mjs'];
const output=createWriteStream(log);
const env={...process.env,TINA_TEST_DSH_ROOT:join(root,'runtime/dsh-0.1.5-rc.2')};
const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done)});
await new Promise(done=>output.end(done));
const bytes=await readFile(log),text=bytes.toString();
const count=label=>Number(text.match(new RegExp('(?:ℹ|#) '+label+' (\\d+)'))?.[1]??NaN);
const files=['package.json','src/fusion-extensions.mjs','src/fusion-tool-results.mjs','src/fusion-app.mjs','src/fusion-native-loop.mjs',
 'src/fusion-world.mjs','src/fusion-tool-presentation.mjs','src/fusion-execution-policy.mjs','src/fusion-prompts.mjs',
 'upstream/cortico/src/web/server.ts','upstream/cortico/src/bot.ts','upstream/dsh-tools/src/index.ts','upstream/dsh-tools/src/ptc.ts',
 'upstream/cortico/src/web/client/main.ts','upstream/cortico/src/web/client/shell/index.ts'];
const report={productVersion:version,status:code===0?'passed':'failed',exitCode:code,command:[process.execPath,...args],
 startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),
 tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled'),
 optionalLegacyDistribution:env.TINA_CORTICO_TEST_DISTRIBUTION??null,log,logSha256:createHash('sha256').update(bytes).digest('hex'),
 files:await Promise.all(files.map(async file=>({file,sha256:createHash('sha256').update(await readFile(join(root,file))).digest('hex')})))};
await writeFile(join(root,'docs','FUSION'+revision+'_ROOT_TEST_RESULT.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));process.exitCode=code;
