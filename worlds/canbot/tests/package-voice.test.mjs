import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANBOT } from '../src/definition.mjs';
import { CoordinatedCanbotWorld } from '../src/coordinated/integrated-world.mjs';
import { VOICE_SECRET } from '../src/config.mjs';

test('packaged coordinated World is opt-in; describe and construction do not resolve secrets', async () => {
  let calls=0; const cfg={...CANBOT.defaults(),headEnabled:true};
  const ctx={cfg,secret:()=>{calls++;throw Error('unexpected');}};
  assert.equal(cfg.coordinatedVoiceEnabled,false);
  assert.ok(!(CANBOT.create(ctx) instanceof CoordinatedCanbotWorld));
  const enabled=CANBOT.create({...ctx,cfg:{...cfg,coordinatedVoiceEnabled:true}});
  assert.ok(enabled instanceof CoordinatedCanbotWorld); assert.equal(calls,0);
  assert.ok(enabled.tools().some(t=>t.name==='canbot_voice_control'));
  assert.equal(calls,0); assert.equal(VOICE_SECRET,'CORTICO_CANBOT_VOICE_TOKEN');
  await assert.rejects(enabled.start({pushEvent(){},log:{warn(){}}}), /coordinated_world_configuration_missing/);
  assert.equal(calls,0);
  const described=JSON.parse(await readFile(new URL('../describe.json',import.meta.url),'utf8'));
  assert.deepEqual(described.tools,CANBOT.describe.tools);
  assert.ok(described.events.some(e=>e.type==='canbot.speech'));
  assert.ok(described.events.some(e=>e.type==='canbot.power'));
});

test('registered enabled World resolves its separate voice secret only at startup', async t => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'voice-registration-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const ipc=join(dir,'ipc'); await mkdir(ipc,{mode:0o700}); const calls=[];
  const cfg={...CANBOT.defaults(), headEnabled:true, coordinatedVoiceEnabled:true,
    apiBaseUrl:'http://127.0.0.1:1',mediaBaseUrl:'http://127.0.0.1:1',avatarBaseUrl:'http://127.0.0.1:1',
    headUplinkBind:'127.0.0.1',headUplinkPort:0,voiceControlBind:'127.0.0.1',voiceControlPort:0,
    voiceStateDir:join(dir,'state'),voiceSpoolRoot:join(dir,'spool'),voiceJournalDir:join(dir,'voice'),
    mediaArbitrationJournalDir:join(dir,'media'),mediaIpcDir:ipc,mediaAllowedRoots:[dir],mediaPlaybackHelper:'/bin/true',
    mediaPlaybackHelperSha256:'a'.repeat(64),mediaPlaybackLinkPath:join(dir,'link.json')};
  const world=CANBOT.create({cfg,secret:(name)=>{calls.push(name);return (name===VOICE_SECRET?'v':'a').repeat(64);}});
  assert.deepEqual(calls,[]); world.head.start=async()=>{};world.head.stop=async()=>{};
  world.head.request=async()=>({foreground:false});world.client.request=async()=>{throw Error('offline');};
  try {
    await world.start({pushEvent:async e=>({...e,cursor:1}),log:{warn(){}}});
    assert.ok(calls.includes(VOICE_SECRET)); const port=world.voiceBridge.server.address().port;
    const r=await fetch(`http://127.0.0.1:${port}/v1/voice-status`,{headers:{Authorization:`Bearer ${'v'.repeat(64)}`}});
    assert.equal(r.status,200);assert.equal((await r.json()).config.mode,'silence_stop');
  } finally {await world.stop();}
});

test('coordinated start rejects voice token reuse before starting World', async () => {
  const cfg={...CANBOT.defaults(),headEnabled:true,coordinatedVoiceEnabled:true,voiceStateDir:'/tmp/s',voiceSpoolRoot:'/tmp/a',voiceJournalDir:'/tmp/v',
    mediaArbitrationJournalDir:'/tmp/m',mediaIpcDir:'/tmp/i',mediaAllowedRoots:['/tmp'],mediaPlaybackHelper:'/bin/true',
    mediaPlaybackHelperSha256:'a'.repeat(64),mediaPlaybackLinkPath:'/tmp/link'};
  const world=CANBOT.create({cfg,secret:()=> 'a'.repeat(64)});let started=false;
  world.head.start=async()=>{started=true;};
  await assert.rejects(world.start({pushEvent(){},log:{warn(){}}}),/voice_token_invalid_or_reused/);
  assert.equal(started,false);
});
