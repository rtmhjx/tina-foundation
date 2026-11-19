import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVoiceWorldBridge, voiceTool, speechWaitTool } from './stream-world-bridge.mjs';

test('assembly is idle by default and model/screen share one controller configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(),'voice-world-')); let networkCalls = 0;
  const bridge = await createVoiceWorldBridge({ head: { request() { networkCalls++; throw Error('not expected'); } },
    host: { pushEvent() {} }, stateDir: join(dir,'state'), spoolRoot: join(dir,'spool'), journalDir: join(dir,'journal'),
    token: 'x'.repeat(64), stt: async () => '' });
  try {
    assert.equal(networkCalls, 0); assert.equal(bridge.server.listening, false);
    const tool = bridge.tools()[0], initial = JSON.parse((await tool.handler({ action: 'status' })).text);
    assert.equal(initial.state, 'idle'); assert.equal(initial.config.mode, 'silence_stop');
    const changed = await tool.handler({ action: 'configure', config: { mode: 'press_stop', silenceMs: 1500,
      batch: { strategy: 'duration_ms', threshold: 60000 } } });
    assert.equal(JSON.parse(changed.text).config.mode, 'press_stop'); assert.equal(bridge.controller.status().configRevision, 2);
    assert.equal(networkCalls, 0);
  } finally { await bridge.close(); await rm(dir, { recursive: true, force: true }); }
});


test('World can stop a starting session even when enabled is unknown', async () => {
  const id='cdd65d3a-0146-4cff-b16c-7f07746eb734'; let command;
  const tool=voiceTool({ status:()=>({enabled:null,sessionId:id,configRevision:3}), model:async value=>{command=value;return {state:'stopping'};} });
  const result=await tool.handler({action:'stop'});
  assert.equal(result.failed,undefined); assert.equal(command.desiredEnabled,false); assert.equal(command.expectedSessionId,id);
  assert.equal((await tool.handler({action:'toggle'})).failed,true);
});

test('semantic wait is bounded, interruptible, and does not toggle the microphone', async () => {
  let calls = 0; const batcher = { wait: async args => { calls++; return { speechRevision: args.expectedSpeechRevision,
    reason: 'activity_detected', vadState: 'activity' }; } };
  const tool = speechWaitTool({ engine: { state: 'running', batcher } });
  assert.equal(tool.barrierAfter, true); assert.equal(tool.interruptible, true);
  assert.equal((await tool.handler({ expectedSpeechRevision: 1, waitMs: 5001 })).failed, true);
  const result = JSON.parse((await tool.handler({ expectedSpeechRevision: 4, waitMs: 300 })).text);
  assert.equal(result.reason, 'activity_detected'); assert.equal(calls, 1);
  assert.equal(JSON.parse((await speechWaitTool({ engine: { state: 'stopped', batcher } }).handler({ expectedSpeechRevision: 4, waitMs: 300 })).text).state, 'not_listening');
  assert.equal(calls, 1);
});
