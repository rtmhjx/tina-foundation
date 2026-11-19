window.__ModuleLoader__.load({id:"@tina/cortico-host-client",factory:(require)=>{
const module={exports:{}};const exports=module.exports;
'use strict';

const EVENT = 'cortico/host-world-speech';
const NODE = 'cortico-world-speech';
const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

/** A World action is its own durable chat node, never a fabricated model response. */
const worldSpeechDefinition = {
  kind: NODE,
  target: 'chat',
  match(event) {
    return event.type === EVENT && typeof event.data?.id === 'string'
      && typeof event.data?.text === 'string' ? { id: event.data.id, role: 'start' } : null;
  },
  start(_context, match) {
    return { ...match.event.data, seq: match.event.seq, time: match.event.time };
  },
  update(context) { return context.state; },
  buildViewNode(context) {
    const data = context.state;
    if (!data) return null;
    return { key: context.key, id: context.id, kind: NODE, target: 'chat', anchorSeq: data.seq,
      location: { kind: 'session' }, visibility: 'visible', data };
  },
};

function WorldSpeechView({ node }) {
  const { createElement } = require('react');
  const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
  return createElement('article', {
    'data-cortico-world-speech': node.data.id,
    style: { margin: '12px 0', padding: '12px 16px', borderRadius: '12px',
      border: '1px solid var(--border-color, #42464b)', background: 'var(--bg-secondary, #23272b)' },
  }, createElement('div', { style: { fontSize: '11px', opacity: 0.65, marginBottom: '6px' } },
    'World · ' + (node.data.worldId ?? 'host-chat')),
  createElement(MarkdownText, { text: node.data.text, labels: MARKDOWN_LABELS }));
}

const inject = ['uiConversation', 'slots'];
function apply(ctx) {
  ctx.uiConversation.events.register(worldSpeechDefinition);
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: NODE }, WorldSpeechView));
}

module.exports = { apply, inject, worldSpeechDefinition, WorldSpeechView, EVENT, NODE };

return module.exports;
}});
