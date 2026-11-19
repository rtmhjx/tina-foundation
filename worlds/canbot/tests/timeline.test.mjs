import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventTimeline, splitOriginal } from '../src/timeline.mjs';
import { HeadChannel } from '../src/head-channel.mjs';

const INSTANCE = '11111111-1111-4111-8111-111111111111', TOKEN = 'a'.repeat(64);
const event = (cursor, text) => ({ cursor, run: 'fixture-run', source: 'console', type: 'console.message', ts: '2026-10-28T10:00:00+08:00', text, origin: 'external' });
async function fixture(t, { events = [], historyEvents = 40, loseFirstResponse = false } = {}) {
  const posted = [], accepted = [], state = { instance: INSTANCE, lastSequence: 0, streamId: null };
  let previous, lost = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/status') return res.end(JSON.stringify({ instanceId: state.instance, timeline: { schemaVersion: 'canbot.timeline.v1', lastSequence: state.lastSequence } }));
    assert.equal(req.url, '/v1/timeline');const parts=[];for await (const p of req) parts.push(p);
    const raw=Buffer.concat(parts);assert.ok(raw.length<=262144);const body=JSON.parse(raw);posted.push({raw:raw.toString(),body});
    if (body.streamId !== state.streamId) { state.streamId=body.streamId;state.lastSequence=0;previous=null; }
    if (body.sequence === state.lastSequence) assert.equal(raw.toString(), previous);
    else { assert.equal(body.sequence,state.lastSequence+1);state.lastSequence=body.sequence;previous=raw.toString();accepted.push(...body.entries); }
    if (loseFirstResponse&&!lost) { lost=true;res.destroy();return; }
    res.statusCode=202;res.end(JSON.stringify({accepted:true,instanceId:state.instance,streamId:state.streamId,sequence:state.lastSequence}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const head=new HeadChannel({avatarBaseUrl:`http://127.0.0.1:${server.address().port}`,mediaBaseUrl:'http://127.0.0.1:1',deviceId:'canbot-head',bindHost:'127.0.0.1',bindPort:0,avatarToken:()=>TOKEN,mediaToken:()=>TOKEN});
  const timeline=new EventTimeline(head,{historyEvents});
  let modelInputs=0;
  const host={store:{get:c=>events.find(e=>e.cursor===c),latestCursor:()=>events.at(-1)?.cursor??0,range:({limit})=>events.slice(-limit)},pushEvent:()=>{modelInputs++;throw Error('display must not push');}};
  timeline.start(host);clearTimeout(timeline.timer);timeline.timer=null;
  t.after(async()=>{await timeline.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {timeline,posted,accepted,state,events,modelInputs:()=>modelInputs};
}

test('full original text survives Unicode chunking and bounded real HTTP packets without a model input',async t=>{
  const original=('真实来源\n一整段文本 🐋\t由事件库提供\n').repeat(2200),f=await fixture(t,{events:[event(1,original)]});
  for(let i=0;i<30&&f.timeline.sourceCursor<1;i++)await f.timeline.poll();
  assert.equal(f.timeline.sourceCursor,1);assert.equal(f.accepted.map(p=>p.text).join(''),original);
  assert.ok(f.posted.length>1);assert.ok(f.accepted.every(p=>p.text.length<=2048&&p.id==='core:fixture-run:1'));
  assert.ok(f.accepted.every(p=>!/[\uD800-\uDBFF]$/.test(p.text)&&!(/^[\uDC00-\uDFFF]/.test(p.text))));
  assert.ok(f.posted.every(p=>p.body.mode==='replay'));assert.equal(f.modelInputs(),0);
});

test('a lost display response repeats the same packet and advances the source cursor only on a matching receipt',async t=>{
  const f=await fixture(t,{events:[event(1,'source text')],loseFirstResponse:true});await f.timeline.poll();
  assert.equal(f.timeline.sourceCursor,0);assert.equal(f.accepted.length,1);
  await f.timeline.poll();assert.equal(f.posted.length,2);assert.equal(f.posted[0].raw,f.posted[1].raw);
  assert.equal(f.accepted.length,1);assert.equal(f.timeline.sourceCursor,1);
});

test('history disabled waits for a real new source record instead of generating filler',async t=>{
  const f=await fixture(t,{events:[event(1,'old')],historyEvents:0});await f.timeline.poll();assert.equal(f.posted.length,0);
  f.events.push(event(2,'new real observation'));await f.timeline.poll();
  assert.equal(f.posted[0].body.mode,'live');assert.equal(f.accepted[0].text,'new real observation');assert.equal(f.modelInputs(),0);
});

test('only completed public assistant text enters the display tap, with stable item deduplication',async t=>{
  const f=await fixture(t);
  f.timeline.output({type:'response.reasoning_text.delta',delta:'not a display event'});
  const output={type:'response.output_item.done',item:{id:'msg-fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'actual public output'}]}};
  f.timeline.output(output);f.timeline.output(output);await f.timeline.poll();
  assert.equal(f.accepted.length,1);assert.equal(f.accepted[0].text,'actual public output');assert.equal(f.accepted[0].source,'assistant');assert.equal(f.modelInputs(),0);
});

test('receiver restart replays retained source under the new receiver instance',async t=>{
  const f=await fixture(t,{events:[event(1,'recorded source')]});await f.timeline.poll();
  f.state.instance='22222222-2222-4222-8222-222222222222';f.state.lastSequence=0;f.state.streamId=null;
  await f.timeline.poll();assert.equal(f.posted.length,2);assert.equal(f.posted[1].body.instanceId,f.state.instance);
  assert.equal(f.posted[1].body.sequence,1);assert.equal(f.posted[1].body.mode,'replay');
});

test('empty text remains an empty source record',()=>assert.deepEqual(splitOriginal(''),['']));
