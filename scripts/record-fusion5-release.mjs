import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const release=resolve(process.argv[2]??join(root,'artifacts/tina-cortico-fusion-20261113-r5'));
const benchmark=resolve(process.argv[3]??join(root,'.tina-fusion-dev/release-efficiency-r5/benchmark-receipt.json'));
const json=async path=>JSON.parse(await readFile(path));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashFile=async path=>hash(await readFile(path));
const suite=await json(join(root,'docs/FUSION5_ROOT_TEST_RESULT.json'));
const official=await json(join(root,'docs/FUSION5_OFFICIAL_AUTONOMY_RESULT.json'));
const ui=await json(join(root,'docs/FUSION5_UI_RESULT.json'));
const upstream=await json(join(root,'docs/FUSION5_UPSTREAM_CHECK_RESULT.json'));
const install=await json(join(release,'INSTALLATION_RECEIPT.json'));
const verify=await json(join(release,'PACKAGE_VERIFICATION.json'));
const cli=await json(join(release,'PACKAGE_CLI_VERIFICATION.json'));
const bench=await json(benchmark);
const pkg=await json(join(root,'package.json')), shipped=await json(join(release,'package.json'));
assert.equal(pkg.version,'0.2.0-fusion.5');
assert.equal(suite.productVersion,pkg.version);assert.equal(suite.exitCode,0);
assert.equal(suite.failed,0);assert.equal(suite.cancelled,0);assert.equal(suite.skipped,0);
assert.equal(official.status,'passed');assert.equal(official.productVersion,pkg.version);
assert.ok(Object.values(official.acceptance).every(Boolean));
assert.ok(Array.isArray(official.sourceFiles)&&official.sourceFiles.length>0);
for(const row of official.sourceFiles)assert.equal(await hashFile(join(root,row.file)),row.sha256,'Official acceptance source changed: '+row.file);
assert.equal(upstream.status,'passed');assert.ok(upstream.typechecks.every(row=>row.exitCode===0));assert.equal(upstream.web.failed,0);
assert.equal(official.independentGeneratedTool.status,'passed');
assert.ok(ui.complete&&ui.appClosed&&ui.modelRequests===0&&ui.credentialConfigured===false);
assert.equal(install.complete,true);assert.equal(verify.complete,true);
assert.equal(cli.status,'passed');assert.equal(cli.version,pkg.version);assert.equal(cli.terminal.code,0);
assert.ok(cli.newBackendSameStatePortSession&&cli.ordinaryShutdownNoRelaunch&&cli.recordedMainCalls===0);
assert.equal(verify.credentialConfigured,false);assert.equal(verify.coreReactivation,true);
assert.equal(verify.importedModulesIsolated,true);assert.equal(bench.status,'PASS');assert.equal(bench.summary.FAIL,0);
for(const field of ['name','version','type','exports','dependencies','engines'])assert.deepEqual(shipped[field],pkg[field]);
for(const row of suite.files){assert.equal(await hashFile(join(root,row.file)),row.sha256,'Changed validated checkout: '+row.file);
 if(row.file!=='package.json')assert.equal(await hashFile(join(release,row.file)),row.sha256,'Release differs: '+row.file);}
for(const row of official.sourceFiles)assert.equal(await hashFile(join(release,row.file)),row.sha256,'Release differs from official acceptance: '+row.file);
const sourceFiles=[];
async function compareSource(relative){
 for(const entry of await readdir(join(root,relative),{withFileTypes:true})){
  const path=relative+'/'+entry.name;
  if(entry.isDirectory())await compareSource(path);
  else if(entry.isFile()){const digest=await hashFile(join(root,path));assert.equal(await hashFile(join(release,path)),digest,path);sourceFiles.push({path,sha256:digest});}
 }
}
await compareSource('src');
const native=[];
for(const stem of ['dsh-agent-loop','dsh-file-upload','dsh-tools']){
 const current=await json(join(root,'vendor',stem+'-source-lock.json'));
 const built=await json(join(release,'vendor',stem+'-source-lock.json'));
 assert.equal(current.sourceTreeSha256,built.sourceTreeSha256);native.push({package:built.package,sourceTreeSha256:built.sourceTreeSha256});
}
const files=[...['FUSION5_ROOT_TEST_RESULT.json','FUSION5_OFFICIAL_AUTONOMY_RESULT.json','FUSION5_GENERATED_TOOL_CHECK.json','FUSION5_UI_RESULT.json','FUSION5_UPSTREAM_CHECK_RESULT.json']
 .map(file=>({label:'docs/'+file,path:join(release,'docs',file)})),
 ...['INSTALLATION_RECEIPT.json','PACKAGE_VERIFICATION.json','PACKAGE_CLI_VERIFICATION.json'].map(file=>({label:file,path:join(release,file)})),{label:'installed-feature-benchmark',path:benchmark}];
const report={format:1,productVersion:pkg.version,status:'complete',recordedAt:new Date().toISOString(),releaseDirectory:release,
 originalEnvironmentsModified:false,cadStatistics:'deferred-by-user',
 resolvedFindings:['F4-A01 extension initialization cleanup','F4-A02 Windows path identity','F4-A03 captured PTC finalizer identity',
 'F4-A04 live and global shell status synchronization','additional consumed-input wake coalescing','persistent selectable extension history'],
 rootChecks:{passed:suite.passed,failed:suite.failed,cancelled:suite.cancelled,skipped:suite.skipped,elapsedMs:suite.elapsedMs},
 upstreamChecks:{typechecks:upstream.typechecks,web:upstream.web},
 officialAutonomy:{status:official.status,model:official.model,operatorInputs:official.operatorInputs,goalId:official.sameGoalId,
  processPids:official.processPids,requests:official.requests,usage:official.usage.totals,totalTokens:official.completeRunTokens,
  transition:official.transition,wakeRead:official.wakeRead,allWakeReads:official.allWakeReads,acceptance:official.acceptance,
  independentToolChecks:official.independentGeneratedTool.checks,priorAttempts:official.priorAttempts,
  allAttemptsUsage:official.allOfficialAttemptsUsage,cleanup:official.cleanup,prices:null},
 independentRelease:{offline:install.offline,verifiedFiles:verify.verifiedFiles,manifestSha256:verify.payloadIntegrity.manifestSha256,
  sourceBuilt:verify.sourceBuilt,importedModulesIsolated:verify.importedModulesIsolated,coreReactivation:verify.coreReactivation,
  cli:{status:cli.status,newBackendSameStatePortSession:cli.newBackendSameStatePortSession,
    ordinaryShutdownNoRelaunch:cli.ordinaryShutdownNoRelaunch,recordedMainCalls:cli.recordedMainCalls,terminal:cli.terminal},
  credentialConfigured:verify.credentialConfigured,sourceFilesMatchValidatedCheckout:true,nativeSourceTrees:native,
  installCommands:install.commands.map(c=>({command:c.command,exitCode:c.exitCode})),benchmark:bench.summary},
 ui:{complete:ui.complete,modelRequests:ui.modelRequests,snapshots:ui.snapshots.map(s=>({label:s.label,paused:s.loop.paused,scheduleBlocked:s.loop.scheduleBlocked}))},
 sourceFiles,evidence:await Promise.all(files.map(async file=>({file:file.label,path:file.path,sha256:await hashFile(file.path)}))),
 boundaries:['Observed official model: DeepSeek only; no statistical model ranking or fee quote.',
 'Startup delivery was held until the restored intention wake was archived; no second operator message was submitted.',
 'The bot and all test files were synthetic; the optional desktop shell, external accounts and long-duration uptime are separate acceptance scopes.']};
for(const target of [join(root,'docs/FUSION5_RELEASE_RESULT.json'),join(release,'FUSION5_RELEASE_RESULT.json')])await writeFile(target,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,version:pkg.version,release,verifiedFiles:verify.verifiedFiles,rootTests:suite.passed,officialMainCalls:official.requests.main,benchmark:bench.summary}));
