import { randomUUID } from 'node:crypto';

const speechTool = { name: 'host_chat_send', description: 'Send a chosen outward message to this host chat window.',
  tags: ['speak'], parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'], additionalProperties: false } };

/** The host window is an external World; model final text remains internal. */
export function createHostChatWorld({ sessionId, sendSpeech, ctx }) {
  let host;
  const pending = new Map();
  const world = {
    id: 'host-chat',
    envPromptVars: () => null,
    async start(value) { host = value; },
    async stop() { host = undefined; },
    async receive(input) {
      if (!host) throw Object.assign(new Error('The host chat World is not ready.'), { code: 'HOST_WORLD_NOT_READY' });
      const id = input.eventId ?? input.requestId ?? input.rpcId ?? input.id ?? randomUUID();
      if (pending.has(id)) return pending.get(id);
      const blocks = input.content ?? [];
      const unsupported = blocks.find(block => !['text', 'image'].includes(block.type));
      if (unsupported) throw Object.assign(new Error('This host World accepts text and image input; other attachment kinds require a declared World adapter.'), { code: 'HOST_CONTENT_UNSUPPORTED' });
      const blobs = [];
      for (const block of blocks) if (block.type === 'image') {
        const image = await ctx.attachments.readImage(block.attachment);
        blobs.push({ bytes: image.data ?? image.bytes, mime: block.attachment.mediaType, name: block.attachment.name ?? 'host-image' });
      }
      const text = input.text ?? input.prompt ?? blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const task = host.pushEvent({ type: 'host-chat.message', source: 'host-chat', origin: 'external',
        ts: new Date().toISOString(), senderKey: 'host-chat.operator',
        text: String(text), ...(blobs.length ? { blobs } : {}),
        meta: { sessionId, requestId: id, source: 'dsh-window', ...(input.attachments ? { attachments: input.attachments } : {}) },
      }, { trigger: 'flush' });
      pending.set(id, task);
      try { return await task; }
      catch (error) { pending.delete(id); throw error; }
    },
    tools: () => [{ ...speechTool,
      async handler(args) {
        if (!host || typeof args.text !== 'string' || !args.text.trim()) throw new Error('Host speech requires a running World and nonempty text.');
        const receipt = await sendSpeech({ text: args.text, worldId: 'host-chat', sessionId, id: randomUUID() });
        await host.pushEvent({ type: 'host-chat.self', source: 'host-chat', origin: 'internal', ts: new Date().toISOString(),
          text: args.text, meta: { sessionId, receipt } }, { deliver: false });
        return JSON.stringify({ sent: true, receipt });
      } }],
  };
  return { world, definition: { id: 'host-chat', label: 'Host conversation',
    defaults: () => ({ enabled: true }), create: () => world,
    describe: { tools: [{ ...speechTool, summary: { en: 'Speak in the bound host window.', zh: '在所绑定的宿主窗口对外发言。' } }],
      events: [{ type: 'host-chat.message', description: { en: 'A message from the bound host window.', zh: '所绑定宿主窗口发来的消息。' }, trigger: 'flush' },
        { type: 'host-chat.self', description: { en: 'An archived outward message from this World; does not wake the Bot.', zh: '本 World 已发出的消息存档，不唤醒 Bot。' } }] } } };
}
