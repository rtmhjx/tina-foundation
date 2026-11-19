import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fusionNpmCli } from '../scripts/setup-fusion-memory.mjs';
import { selectFusionBot } from '../src/fusion-bot-selection.mjs';
import { openFusionApp } from '../src/fusion-app.mjs';

const root=resolve(import.meta.dirname,'..');
const archive=resolve(process.argv[2]);
await mkdir(join(root,'.tina-fusion-dev'),{recursive:true});
const work=await mkdtemp(join(root,'.tina-fusion-dev','guidance-host-'));
const stateDir=join(work,'state');
const report={status:'running',archive,archiveSha256:createHash('sha256').update(await readFile(archive)).digest('hex'),
  work,startedAt:new Date().toISOString(),checks:[],externalModelCalls:0};
const check=(name)=>report.checks.push(name);
let app;
const open=async()=>{
  app=await openFusionApp({stateDir,port:0,beforeStart({bot,ctx}){
    bot.core.bus.setPaused(true);
    ctx.on('llm/stream',()=>{report.externalModelCalls++;throw new Error('No model calls in guidance lifecycle acceptance');});
  }});
  assert.equal(app.bot.parts.persona.sourceSessionId,app.sessionId);
};
const guidance=async()=>{
  const view=await app.prompts.inspect();
  const section=view.sections.find(row=>row.sourceKey==='selfMem.memoryGuidance'||row.name.endsWith(':记忆使用引导'));
  assert.ok(section,'Actual assembled native system must contain guidance');
  return section.text;
};
try{
  await mkdir(join(stateDir,'extensions'),{recursive:true});
  await promisify(execFile)(process.execPath,[fusionNpmCli(),'install','--offline','--ignore-scripts','--no-audit','--no-fund',
    '--cache',join(work,'npm-cache'),'--prefix',join(stateDir,'extensions'),archive],{windowsHide:true});
  await selectFusionBot({stateDir,bot:'@tina/self-mem'});
  await mkdir(join(stateDir,'deployment'),{recursive:true});
  await writeFile(join(stateDir,'deployment/config.json'),JSON.stringify({worlds:{console:{enabled:true}},
    selfMem:{memoryGuidance:{mode:'guided'},agentId:'guidance-host-synthetic',remoteUrl:'',remoteToken:''}}));
  await open();
  const sessionId=app.sessionId;
  const original=await guidance();
  assert.ok(original.includes('先检索相关记忆'));check('actual-native-guided-prefix');
  assert.equal(app.bot.core.session.records.length,0);
  await app.bot.parts.persona.configureRuntime({memoryGuidance:{mode:'minimal'}});
  assert.equal(await guidance(),original);check('configuration-does-not-change-current-session');
  await app.close();app=undefined;await open();
  assert.equal(app.sessionId,sessionId);assert.equal(await guidance(),original);
  assert.equal((await app.bot.parts.persona.status()).memoryGuidance.active.mode,'guided');
  check('empty-native-session-reopen-retains-guidance');
  app.bot.parts.persona.bumpPrefixRevision();
  assert.equal(await guidance(),original);check('explicit-refresh-retains-guidance');
  await app.nativeLoop.clearSession();
  assert.equal((await app.bot.parts.persona.status()).memoryGuidance.active.mode,'minimal');
  const minimal=await guidance();assert.ok(!minimal.includes('先检索相关记忆'));check('native-clear-selects-configured-mode');
  await app.bot.parts.persona.configureRuntime({memoryGuidance:{mode:'guided',rules:{verifyChanges:false}}});
  await app.nativeLoop.clearSession();
  const guided=await guidance();assert.ok(guided.includes('先检索相关记忆'));
  assert.ok(!guided.includes('遇到改口、冲突或状态变化'));check('independent-rule-switch-in-actual-prefix');
  await app.close();app=undefined;await open();
  assert.equal(await guidance(),guided);check('cleared-session-reopen-retains-rule-selection');
  assert.equal(report.externalModelCalls,0);
  report.sessionId=sessionId;report.status='passed';
}catch(error){report.error=String(error.stack??error);throw error;}
finally{
  await app?.close();report.finishedAt=new Date().toISOString();
  await writeFile(join(work,'RESULT.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
