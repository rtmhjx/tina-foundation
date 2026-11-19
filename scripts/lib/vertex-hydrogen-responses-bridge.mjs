import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PI_AI_GOOGLE_PATH = join(
  ROOT,
  'runtime/dsh-0.1.5-rc.2/node_modules/.packages/@earendil-works+pi-ai@0.85.1-be55d35926/dist/api/google-generative-ai.js',
);

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function loadVertexConfigFromHome() {
  const cfgPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  const raw = readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  const opts = cfg?.provider?.['google-vertex']?.options;
  const apiKey = opts?.apiKey;
  const baseUrl = opts?.baseURL;
  if (typeof apiKey !== 'string' || !apiKey || typeof baseUrl !== 'string' || !baseUrl) {
    throw new Error('Missing google-vertex apiKey or baseURL in ~/.config/opencode/opencode.json');
  }
  return { apiKey, baseUrl };
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function sanitizeToolParameters(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { type: 'object', properties: {} };
  }
  return parameters;
}

function encodeEncryptedReasoning(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeEncryptedReasoning(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (decoded && decoded.v === 1) return decoded;
  } catch {}
  return null;
}

function extractTextFromParts(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.refusal === 'string') return part.refusal;
      return '';
    })
    .join('');
}

function convertInputParts(parts) {
  if (typeof parts === 'string') {
    return [{ type: 'text', text: parts }];
  }
  if (!Array.isArray(parts)) {
    return [{ type: 'text', text: '' }];
  }
  const result = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') {
      result.push({ type: 'text', text: String(part.text ?? '') });
    } else if (part.type === 'input_image' && typeof part.image_url === 'string') {
      const match = /^data:(image\/[^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(part.image_url);
      if (match) {
        result.push({ type: 'image', mimeType: match[1], data: match[2].replace(/\s+/g, '') });
      } else {
        result.push({ type: 'text', text: `[image: ${part.image_url.slice(0, 128)}]` });
      }
    } else if (part.type === 'input_file') {
      result.push({ type: 'text', text: `[file: ${part.filename ?? 'attachment'}]` });
    } else if (typeof part.text === 'string') {
      result.push({ type: 'text', text: part.text });
    }
  }
  return result.length > 0 ? result : [{ type: 'text', text: '' }];
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapToolChoice(choice) {
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'any';
  if (choice === 'auto') return 'auto';
  return undefined;
}

function mapThinkingOption(effort) {
  const normalized = String(effort ?? 'high').toLowerCase();
  if (normalized === 'off' || normalized === 'none') return { enabled: false };
  if (normalized === 'minimal') return { enabled: true, level: 'MINIMAL' };
  if (normalized === 'low') return { enabled: true, level: 'LOW' };
  if (normalized === 'medium') return { enabled: true, level: 'MEDIUM' };
  return { enabled: true, level: 'HIGH' };
}

class SignatureStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      version: 1,
      toolCalls: {},
      thinkingByHash: {},
      textByHash: {},
      byItemId: {},
      trailingEmptyTextSigByItemId: {},
    };
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.data = {
          version: 1,
          toolCalls: parsed.toolCalls ?? {},
          thinkingByHash: parsed.thinkingByHash ?? {},
          textByHash: parsed.textByHash ?? {},
          byItemId: parsed.byItemId ?? {},
          trailingEmptyTextSigByItemId: parsed.trailingEmptyTextSigByItemId ?? {},
        };
      }
    } catch {
      // Ignore corrupt/partial cache and start clean.
    }
  }

  save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.filePath);
  }

  recordToolCall(callId, itemId, name, thoughtSignature) {
    if (!thoughtSignature) return;
    if (callId) {
      this.data.toolCalls[callId] = { thoughtSignature, name };
    }
    if (itemId) {
      this.data.byItemId[itemId] = { type: 'toolCall', signature: thoughtSignature };
    }
  }

  recordThinking(itemId, text, thinkingSignature) {
    if (!thinkingSignature) return;
    if (itemId) {
      this.data.byItemId[itemId] = { type: 'thinking', signature: thinkingSignature };
    }
    if (text) {
      this.data.thinkingByHash[sha256(text)] = thinkingSignature;
    }
  }

  recordText(itemId, text, textSignature) {
    if (!textSignature) return;
    if (itemId) {
      this.data.byItemId[itemId] = { type: 'text', signature: textSignature };
    }
    if (text) {
      this.data.textByHash[sha256(text)] = textSignature;
    }
  }

  recordTrailingEmptyText(prevItemId, textSignature) {
    if (!prevItemId || !textSignature) return;
    this.data.trailingEmptyTextSigByItemId[prevItemId] = textSignature;
  }
}

export function openResponsesToPiContext(body, model, sigData) {
  const systemParts = [];
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    systemParts.push(body.instructions);
  }

  const tools = [];
  for (const tool of body.tools ?? []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && typeof tool.name === 'string') {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        parameters: sanitizeToolParameters(tool.parameters),
      });
    } else if (tool.type === 'namespace' && typeof tool.name === 'string' && Array.isArray(tool.tools)) {
      for (const member of tool.tools) {
        if (!member || typeof member !== 'object' || typeof member.name !== 'string') continue;
        tools.push({
          name: `${tool.name}.${member.name}`,
          description: member.description ?? '',
          parameters: sanitizeToolParameters(member.parameters),
        });
      }
    }
  }

  const messages = [];
  const callIdToName = new Map();
  let currentAssistant = null;

  const flushAssistant = () => {
    if (!currentAssistant || currentAssistant.blocks.length === 0) {
      currentAssistant = null;
      return;
    }
    const hasToolCall = currentAssistant.blocks.some(b => b.type === 'toolCall');
    messages.push({
      role: 'assistant',
      content: currentAssistant.blocks,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: hasToolCall ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    });
    currentAssistant = null;
  };

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input, timestamp: Date.now() });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
        const text = extractTextFromParts(item.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (item.type === 'message' && item.role === 'user') {
        flushAssistant();
        if (typeof item.content === 'string') {
          messages.push({ role: 'user', content: item.content, timestamp: Date.now() });
        } else {
          messages.push({ role: 'user', content: convertInputParts(item.content), timestamp: Date.now() });
        }
        continue;
      }

      if (item.type === 'reasoning') {
        currentAssistant ??= { blocks: [] };
        const contentText = extractTextFromParts(item.content);
        const summaryText = extractTextFromParts(item.summary);
        const text = contentText || summaryText;
        const encrypted = decodeEncryptedReasoning(item.encrypted_content);
        const byId = item.id ? sigData.byItemId?.[item.id] : undefined;
        const thinkingSignature =
          encrypted?.thinkingSignature
          ?? (byId?.type === 'thinking' ? byId.signature : undefined)
          ?? (text ? sigData.thinkingByHash?.[sha256(text)] : undefined);

        if (text || thinkingSignature) {
          currentAssistant.blocks.push({
            type: 'thinking',
            thinking: text,
            ...(thinkingSignature ? { thinkingSignature } : {}),
          });
        }
        if (item.id && sigData.trailingEmptyTextSigByItemId?.[item.id]) {
          currentAssistant.blocks.push({
            type: 'text',
            text: '',
            textSignature: sigData.trailingEmptyTextSigByItemId[item.id],
          });
        }
        continue;
      }

      if (item.type === 'message' && item.role === 'assistant') {
        currentAssistant ??= { blocks: [] };
        const text = extractTextFromParts(item.content);
        const byId = item.id ? sigData.byItemId?.[item.id] : undefined;
        const textSignature =
          (byId?.type === 'text' ? byId.signature : undefined)
          ?? (text ? sigData.textByHash?.[sha256(text)] : undefined);
        if (text || textSignature) {
          currentAssistant.blocks.push({
            type: 'text',
            text,
            ...(textSignature ? { textSignature } : {}),
          });
        }
        if (item.id && sigData.trailingEmptyTextSigByItemId?.[item.id]) {
          currentAssistant.blocks.push({
            type: 'text',
            text: '',
            textSignature: sigData.trailingEmptyTextSigByItemId[item.id],
          });
        }
        continue;
      }

      if (item.type === 'function_call') {
        currentAssistant ??= { blocks: [] };
        const callId = item.call_id;
        const name = item.name;
        if (callId && name) callIdToName.set(callId, name);
        const byId = item.id ? sigData.byItemId?.[item.id] : undefined;
        const thoughtSignature =
          sigData.toolCalls?.[callId]?.thoughtSignature
          ?? (byId?.type === 'toolCall' ? byId.signature : undefined);
        currentAssistant.blocks.push({
          type: 'toolCall',
          id: callId,
          name,
          arguments: parseJsonObject(item.arguments),
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
        if (item.id && sigData.trailingEmptyTextSigByItemId?.[item.id]) {
          currentAssistant.blocks.push({
            type: 'text',
            text: '',
            textSignature: sigData.trailingEmptyTextSigByItemId[item.id],
          });
        }
        continue;
      }

      if (item.type === 'function_call_output') {
        flushAssistant();
        const callId = item.call_id;
        const toolName = callIdToName.get(callId) ?? sigData.toolCalls?.[callId]?.name ?? 'tool';
        messages.push({
          role: 'toolResult',
          toolCallId: callId,
          toolName,
          content: convertInputParts(item.output),
          isError: false,
          timestamp: Date.now(),
        });
        continue;
      }

      if (item.type === 'compaction') {
        flushAssistant();
        const text = typeof item.summary === 'string'
          ? item.summary
          : typeof item.encrypted_content === 'string'
          ? item.encrypted_content
          : '';
        if (text) {
          messages.push({ role: 'user', content: text, timestamp: Date.now() });
        }
      }
    }
    flushAssistant();
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    messages,
    tools: tools.length > 0 ? tools : undefined,
  };
}

function buildBaseResponse({ id, modelId, effort, instructions }) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    status: 'in_progress',
    incomplete_details: null,
    model: modelId,
    previous_response_id: null,
    instructions: instructions ?? null,
    output: [],
    error: null,
    tools: [],
    tool_choice: 'auto',
    truncation: 'disabled',
    parallel_tool_calls: true,
    text: { format: { type: 'text' } },
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    temperature: 1,
    reasoning: { effort, summary: null },
    usage: null,
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: 'default',
    metadata: {},
    safety_identifier: null,
    prompt_cache_key: null,
  };
}

function toOpenResponsesUsage(usage) {
  const cached = usage?.cacheRead ?? 0;
  const inputTokens = (usage?.input ?? 0) + cached;
  const outputTokens = usage?.output ?? 0;
  const reasoningTokens = usage?.reasoning ?? 0;
  const totalTokens = usage?.totalTokens ?? (inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

export async function createVertexHydrogenBridge({
  stateDir,
  modelId = 'gemini-4-hydrogen',
  defaultEffort = 'high',
} = {}) {
  if (!stateDir) throw new Error('stateDir is required for VertexHydrogenBridge');
  const { apiKey, baseUrl } = loadVertexConfigFromHome();
  const { stream: googleStream } = await import(pathToFileURL(PI_AI_GOOGLE_PATH).href);
  const sigStore = new SignatureStore(join(stateDir, 'vertex-signatures.json'));

  const model = {
    id: modelId,
    name: modelId,
    api: 'google-generative-ai',
    provider: 'google-vertex',
    baseUrl,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
  };

  function redactKey(text) {
    return String(text ?? '')
      .replaceAll(apiKey, '[REDACTED_SECRET]')
      .replace(/\bAIza[\w-]+/g, '[REDACTED_SECRET]')
      .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED_SECRET]');
  }

  async function handleResponses(body, res, signal) {
    const requestedModel = body.model ?? modelId;
    if (requestedModel !== modelId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { type: 'invalid_request_error', code: 'MODEL_MISMATCH', message: `Unsupported model: ${requestedModel}` },
      }));
      return;
    }

    const effort = body.reasoning?.effort ?? defaultEffort;
    const context = openResponsesToPiContext(body, model, sigStore.data);
    const thinking = mapThinkingOption(effort);
    const toolChoice = mapToolChoice(body.tool_choice);
    const streaming = body.stream !== false;
    const responseId = `resp_${randomUUID().replaceAll('-', '')}`;
    const requestId = `req_${randomUUID().replaceAll('-', '')}`;
    const baseResponse = buildBaseResponse({
      id: responseId,
      modelId: requestedModel,
      effort,
      instructions: context.systemPrompt,
    });

    let seq = 0;
    let headersSent = false;
    let createdSent = false;
    const outputItems = [];
    let lastOpenItemId = null;
    const activeToolCalls = new Map();
    let pendingThinking = null;
    let pendingText = null;

    const sendSse = event => {
      if (res.writableEnded) return;
      const payload = { ...event, sequence_number: seq++ };
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const ensureSseHeaders = () => {
      if (headersSent || !streaming) return;
      headersSent = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'x-request-id': requestId,
      });
    };

    const ensureCreated = () => {
      if (createdSent || !streaming) return;
      ensureSseHeaders();
      createdSent = true;
      sendSse({ type: 'response.created', response: baseResponse });
    };

    const piStream = googleStream(model, context, {
      apiKey,
      thinking,
      ...(typeof body.max_output_tokens === 'number' ? { maxTokens: body.max_output_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      signal,
    });

    try {
      for await (const ev of piStream) {
        if (signal.aborted) break;

        if (ev.type === 'start') {
          ensureCreated();
          continue;
        }

        if (ev.type === 'thinking_start') {
          pendingThinking = { active: false, text: '', outputIndex: -1, itemId: null };
          continue;
        }

        if (ev.type === 'thinking_delta') {
          const delta = ev.delta ?? '';
          if (!delta) continue;
          ensureCreated();
          if (!pendingThinking) {
            pendingThinking = { active: false, text: '', outputIndex: -1, itemId: null };
          }
          if (!pendingThinking.active) {
            pendingThinking.active = true;
            pendingThinking.outputIndex = outputItems.length;
            pendingThinking.itemId = `rs_${randomUUID().replaceAll('-', '')}`;
            outputItems.push(null);
            if (streaming) {
              sendSse({
                type: 'response.output_item.added',
                output_index: pendingThinking.outputIndex,
                item: { type: 'reasoning', id: pendingThinking.itemId, summary: [], content: [] },
              });
              sendSse({
                type: 'response.content_part.added',
                output_index: pendingThinking.outputIndex,
                item_id: pendingThinking.itemId,
                content_index: 0,
                part: { type: 'reasoning_text', text: '' },
              });
            }
          }
          pendingThinking.text += delta;
          if (streaming) {
            sendSse({
              type: 'response.reasoning.delta',
              output_index: pendingThinking.outputIndex,
              item_id: pendingThinking.itemId,
              content_index: 0,
              delta,
            });
          }
          continue;
        }

        if (ev.type === 'thinking_end') {
          const block = ev.partial?.content?.[ev.contentIndex];
          const thinkingSignature = block?.thinkingSignature;
          const fullText = pendingThinking?.text ?? ev.content ?? '';
          if (pendingThinking?.active) {
            const { outputIndex, itemId } = pendingThinking;
            const encryptedContent = thinkingSignature
              ? encodeEncryptedReasoning({ v: 1, thinkingSignature })
              : undefined;
            const item = {
              type: 'reasoning',
              id: itemId,
              summary: [],
              content: [{ type: 'reasoning_text', text: fullText }],
              ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
            };
            outputItems[outputIndex] = item;
            lastOpenItemId = itemId;
            sigStore.recordThinking(itemId, fullText, thinkingSignature);
            if (streaming) {
              sendSse({
                type: 'response.reasoning.done',
                output_index: outputIndex,
                item_id: itemId,
                content_index: 0,
                text: fullText,
              });
              sendSse({
                type: 'response.content_part.done',
                output_index: outputIndex,
                item_id: itemId,
                content_index: 0,
                part: { type: 'reasoning_text', text: fullText },
              });
              sendSse({
                type: 'response.output_item.done',
                output_index: outputIndex,
                item,
              });
            }
          } else if (thinkingSignature) {
            ensureCreated();
            const outputIndex = outputItems.length;
            const itemId = `rs_${randomUUID().replaceAll('-', '')}`;
            const encryptedContent = encodeEncryptedReasoning({ v: 1, thinkingSignature });
            const item = {
              type: 'reasoning',
              id: itemId,
              summary: [],
              content: [],
              encrypted_content: encryptedContent,
            };
            outputItems.push(item);
            lastOpenItemId = itemId;
            sigStore.recordThinking(itemId, '', thinkingSignature);
            if (streaming) {
              sendSse({
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: { type: 'reasoning', id: itemId, summary: [], content: [] },
              });
              sendSse({
                type: 'response.output_item.done',
                output_index: outputIndex,
                item,
              });
            }
          }
          pendingThinking = null;
          continue;
        }

        if (ev.type === 'text_start') {
          pendingText = { active: false, text: '', outputIndex: -1, itemId: null };
          continue;
        }

        if (ev.type === 'text_delta') {
          const delta = ev.delta ?? '';
          if (!delta) continue;
          ensureCreated();
          if (!pendingText) {
            pendingText = { active: false, text: '', outputIndex: -1, itemId: null };
          }
          if (!pendingText.active) {
            pendingText.active = true;
            pendingText.outputIndex = outputItems.length;
            pendingText.itemId = `msg_${randomUUID().replaceAll('-', '')}`;
            outputItems.push(null);
            if (streaming) {
              sendSse({
                type: 'response.output_item.added',
                output_index: pendingText.outputIndex,
                item: {
                  type: 'message',
                  id: pendingText.itemId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: [],
                },
              });
              sendSse({
                type: 'response.content_part.added',
                output_index: pendingText.outputIndex,
                item_id: pendingText.itemId,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              });
            }
          }
          pendingText.text += delta;
          if (streaming) {
            sendSse({
              type: 'response.output_text.delta',
              output_index: pendingText.outputIndex,
              item_id: pendingText.itemId,
              content_index: 0,
              delta,
              logprobs: [],
            });
          }
          continue;
        }

        if (ev.type === 'text_end') {
          const block = ev.partial?.content?.[ev.contentIndex];
          const textSignature = block?.textSignature;
          const fullText = pendingText?.text ?? ev.content ?? '';
          if (pendingText?.active) {
            const { outputIndex, itemId } = pendingText;
            const item = {
              type: 'message',
              id: itemId,
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: fullText, annotations: [] }],
            };
            outputItems[outputIndex] = item;
            lastOpenItemId = itemId;
            sigStore.recordText(itemId, fullText, textSignature);
            if (streaming) {
              sendSse({
                type: 'response.output_text.done',
                output_index: outputIndex,
                item_id: itemId,
                content_index: 0,
                text: fullText,
                logprobs: [],
              });
              sendSse({
                type: 'response.content_part.done',
                output_index: outputIndex,
                item_id: itemId,
                content_index: 0,
                part: { type: 'output_text', text: fullText, annotations: [] },
              });
              sendSse({
                type: 'response.output_item.done',
                output_index: outputIndex,
                item,
              });
            }
          } else if (textSignature && lastOpenItemId) {
            sigStore.recordTrailingEmptyText(lastOpenItemId, textSignature);
          }
          pendingText = null;
          continue;
        }

        if (ev.type === 'toolcall_start') {
          ensureCreated();
          const tc = ev.partial?.content?.[ev.contentIndex];
          const outputIndex = outputItems.length;
          const itemId = `fc_${randomUUID().replaceAll('-', '')}`;
          const callId = tc?.id ?? `call_${randomUUID().replaceAll('-', '')}`;
          const name = tc?.name ?? '';
          outputItems.push(null);
          activeToolCalls.set(ev.contentIndex, { outputIndex, itemId, callId, name, args: '' });
          if (streaming) {
            sendSse({
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: {
                type: 'function_call',
                id: itemId,
                call_id: callId,
                name,
                arguments: '',
                status: 'in_progress',
              },
            });
          }
          continue;
        }

        if (ev.type === 'toolcall_delta') {
          const info = activeToolCalls.get(ev.contentIndex);
          if (!info) continue;
          const delta = ev.delta ?? '';
          info.args += delta;
          if (streaming && delta) {
            sendSse({
              type: 'response.function_call_arguments.delta',
              output_index: info.outputIndex,
              item_id: info.itemId,
              delta,
            });
          }
          continue;
        }

        if (ev.type === 'toolcall_end') {
          const info = activeToolCalls.get(ev.contentIndex);
          activeToolCalls.delete(ev.contentIndex);
          if (!info) continue;
          const tc = ev.toolCall;
          const finalArgs = info.args || JSON.stringify(tc?.arguments ?? {});
          if (streaming && !info.args && finalArgs) {
            sendSse({
              type: 'response.function_call_arguments.delta',
              output_index: info.outputIndex,
              item_id: info.itemId,
              delta: finalArgs,
            });
          }
          const item = {
            type: 'function_call',
            id: info.itemId,
            call_id: tc?.id ?? info.callId,
            name: tc?.name ?? info.name,
            arguments: finalArgs,
            status: 'completed',
          };
          outputItems[info.outputIndex] = item;
          lastOpenItemId = info.itemId;
          sigStore.recordToolCall(item.call_id, info.itemId, item.name, tc?.thoughtSignature);
          if (streaming) {
            sendSse({
              type: 'response.function_call_arguments.done',
              output_index: info.outputIndex,
              item_id: info.itemId,
              arguments: finalArgs,
            });
            sendSse({
              type: 'response.output_item.done',
              output_index: info.outputIndex,
              item,
            });
          }
          continue;
        }

        if (ev.type === 'done') {
          ensureCreated();
          sigStore.save();
          const isLength = ev.reason === 'length';
          const status = isLength ? 'incomplete' : 'completed';
          const terminalType = isLength ? 'response.incomplete' : 'response.completed';
          const finalResponse = {
            ...baseResponse,
            status,
            completed_at: Math.floor(Date.now() / 1000),
            incomplete_details: isLength ? { reason: 'max_output_tokens' } : null,
            output: outputItems,
            usage: toOpenResponsesUsage(ev.message?.usage),
          };
          if (streaming) {
            sendSse({ type: terminalType, response: finalResponse });
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': requestId });
            res.end(JSON.stringify(finalResponse));
          }
          return;
        }

        if (ev.type === 'error') {
          const message = redactKey(ev.error?.errorMessage ?? 'Vertex stream error');
          if (!createdSent) {
            res.writeHead(502, { 'Content-Type': 'application/json', 'x-request-id': requestId });
            res.end(JSON.stringify({ error: { type: 'server_error', code: 'VERTEX_STREAM_ERROR', message } }));
            return;
          }
          const finalOutput = outputItems.map(item => item ?? {
            type: 'message',
            id: `msg_${randomUUID().replaceAll('-', '')}`,
            status: 'incomplete',
            role: 'assistant',
            content: [],
          });
          const failedResponse = {
            ...baseResponse,
            status: 'failed',
            output: finalOutput,
            error: { code: 'VERTEX_STREAM_ERROR', message },
            usage: toOpenResponsesUsage(ev.error?.usage),
          };
          if (streaming) {
            sendSse({ type: 'response.failed', response: failedResponse });
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(502, { 'Content-Type': 'application/json', 'x-request-id': requestId });
            res.end(JSON.stringify({ error: { type: 'server_error', code: 'VERTEX_STREAM_ERROR', message } }));
          }
          return;
        }
      }
    } catch (error) {
      const message = redactKey(error?.message ?? String(error));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'x-request-id': requestId });
        res.end(JSON.stringify({ error: { type: 'server_error', code: 'BRIDGE_ERROR', message } }));
      } else if (!res.writableEnded) {
        sendSse({
          type: 'error',
          error: { type: 'server_error', code: 'BRIDGE_ERROR', message, param: null },
        });
        res.end();
      }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          {
            id: modelId,
            name: modelId,
            context_length: 1000000,
            top_provider: { max_completion_tokens: 65536 },
            architecture: { input_modalities: ['text', 'image'] },
          },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ac.abort(new Error('Client disconnected'));
      });
      const chunks = [];
      try {
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        await handleResponses(body, res, ac.signal);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { type: 'invalid_request_error', code: 'INVALID_REQUEST', message: redactKey(error?.message ?? error) },
          }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const localOrigin = `http://127.0.0.1:${port}`;

  return {
    port,
    localOrigin,
    baseUrl: `${localOrigin}/v1`,
    sigStore,
    redactKey,
    forwardFetch(originalFetch, input, options, publicOrigin = 'https://vertex-hydrogen.local') {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const parsed = new URL(rawUrl);
      if (parsed.origin !== publicOrigin) {
        return originalFetch(input, options);
      }
      const targetUrl = `${localOrigin}${parsed.pathname}${parsed.search}`;
      return originalFetch(targetUrl, options);
    },
    async close() {
      await new Promise(resolveClose => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}
