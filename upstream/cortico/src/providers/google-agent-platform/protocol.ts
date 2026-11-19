/** Native content, signatures and usage mapped to the shared Responses contract. */
import { createHash, randomUUID } from 'node:crypto';
import { createResponse, type OutputItem, type Request, type Response, type StreamEvent } from '../../protocol/open-responses/index.ts';
import { itemText, type ContextRecord, type ItemOrigin } from '../../protocol/open-responses/context.ts';
import { ResponseAccumulator, ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { standardUsage, unknownMeters, type GenerateOptions, type TokenMeters } from '../../core/generation.ts';
import { requestContext, requestSpec } from '../transport/native-input.ts';
import { imageBlobs, type CompatMediaOptions } from '../transport/history.ts';
import type { ResponseAssembly } from '../transport/response-assembly.ts';
import { FOLD_ARGS_PLACEHOLDER, OVERSIZE_PLACEHOLDER } from '../../core/markers.ts';

type Json = Record<string, any>;
type Content = { role: 'user' | 'model'; parts: Json[] };
const SIGNATURE_PREFIX = 'cortico-google-parts-v1:';
const SYNTHETIC_SIGNATURE = 'skip_thought_signature_validator';
interface NativeTurn { parts: Json[]; calls: Array<{ index: number; callId: string; name: string }> }

/** Invalid function names receive deterministic aliases; the original name stays in local Items. */
export function googleToolNames(names: readonly string[]): { encode(name: string): string; decode(name: string): string } {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const name of new Set(names)) {
    let alias = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : `tool_${createHash('sha256').update(name).digest('hex').slice(0,48)}`;
    let ordinal = 0;
    while (reverse.has(alias) && reverse.get(alias) !== name)
      alias = `tool_${createHash('sha256').update(`${name}:${++ordinal}`).digest('hex').slice(0,48)}`;
    forward.set(name, alias); reverse.set(alias, name);
  }
  return {
    encode(name) {
      const alias = forward.get(name);
      if (alias) return alias;
      if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return name;
      return `tool_${createHash('sha256').update(name).digest('hex').slice(0, 48)}`;
    },
    decode(name) {
      return reverse.get(name) ?? name;
    },
  };
}

function sameOrigin(owner: ItemOrigin | undefined, current: ItemOrigin | undefined, model: string | null | undefined): boolean {
  return Boolean(owner && current && owner.instance === current.instance && owner.module === current.module
    && owner.compatibilityDomain === current.compatibilityDomain && owner.model === model && current.model === model);
}
function nativeTurn(entry: ContextRecord, options: GenerateOptions, model: string | null | undefined): NativeTurn | null {
  const item = entry.item;
  if (item.type !== 'reasoning' || !item.encrypted_content?.startsWith(SIGNATURE_PREFIX)
    || !sameOrigin(entry.context.origin, options.origin, model)) return null;
  try {
    const data = JSON.parse(Buffer.from(item.encrypted_content.slice(SIGNATURE_PREFIX.length), 'base64').toString('utf8'));
    if (!Array.isArray(data.parts) || !Array.isArray(data.calls)) throw new Error('Invalid native turn');
    return data as NativeTurn;
  } catch { throw new ResponseProtocolError('Stored native model parts are unreadable'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function explicitlyFolded(entry: ContextRecord): boolean {
  return entry.item.type === 'function_call' ? entry.item.arguments === FOLD_ARGS_PLACEHOLDER
    : (entry.item.type === 'message' || entry.item.type === 'reasoning') && itemText(entry.item) === OVERSIZE_PLACEHOLDER;
}
/** Native parts can be replayed only while they still represent the retained local Items. */
function matchesLocalTurn(turn: NativeTurn, entries: readonly ContextRecord[]): boolean {
  const calls = entries.filter(entry => entry.item.type === 'function_call');
  if (calls.length !== turn.calls.length) return false;
  for (let index = 0; index < calls.length; index++) {
    const item = calls[index].item;
    const association = turn.calls[index];
    const native = turn.parts[association.index]?.functionCall;
    if (item.type !== 'function_call' || item.call_id !== association.callId || item.name !== association.name || !native) return false;
    if (item.arguments === FOLD_ARGS_PLACEHOLDER) return false;
    if (canonical(jsonObject(item.arguments, 'Stored function arguments')) !== canonical(native.args)) return false;
  }
  const localText = entries.filter(entry => entry.item.type === 'message' && entry.item.role === 'assistant').map(entry => itemText(entry.item)).join('');
  const nativeText = turn.parts.filter(part => part.thought !== true).map(part => typeof part.text === 'string' ? part.text : '').join('');
  const localThoughts = entries.filter(entry => entry.item.type === 'reasoning' && !entry.item.encrypted_content).map(entry => itemText(entry.item)).join('');
  const nativeThoughts = turn.parts.filter(part => part.thought === true).map(part => typeof part.text === 'string' ? part.text : '').join('');
  return localText === nativeText && localThoughts === nativeThoughts;
}
function historicalArguments(text: string): Json {
  return text === FOLD_ARGS_PLACEHOLDER ? { _cortico_context: { arguments: FOLD_ARGS_PLACEHOLDER } } : jsonObject(text, 'Function arguments');
}
function jsonObject(text: string, subject: string): Json {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ResponseProtocolError(`${subject} is not JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponseProtocolError(`${subject} must be an object`);
  return value as Json;
}
function dataPart(url: string): Json {
  const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
  if (url.startsWith('gs://')) return { fileData: { fileUri: url } };
  throw new ResponseProtocolError('Native image and file inputs require a base64 data URL or gs:// URI');
}
function inputParts(entry: ContextRecord, media?: CompatMediaOptions): Json[] {
  const item = entry.item;
  const content = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
  const parts: Json[] = [];
  if (typeof content === 'string') { if (content) parts.push({ text: content }); }
  else for (const part of content ?? []) {
    if ('text' in part) parts.push({ text: part.text });
    else if (part.type === 'refusal') parts.push({ text: part.refusal });
    else if (part.type === 'input_image') {
      if (!media?.enabled()) throw new ResponseProtocolError('Image input is disabled for this endpoint');
      if (!part.image_url) throw new ResponseProtocolError('Image input has no image_url');
      parts.push(dataPart(part.image_url));
    } else if (part.type === 'input_file') {
      if (!media?.enabled()) throw new ResponseProtocolError('File input is disabled for this endpoint');
      const data = 'file_data' in part ? part.file_data : undefined;
      const url = 'file_url' in part ? part.file_url : undefined;
      if (!data && !url) throw new ResponseProtocolError('File input has no data or URI');
      parts.push(dataPart(data || url!));
    } else throw new ResponseProtocolError(`Unsupported native input part: ${part.type}`);
  }
  if (media?.enabled()) for (const ref of imageBlobs(entry.context.blobs)) {
    const bytes = media.read(ref.handle);
    if (bytes) parts.push({ inlineData: { mimeType: ref.mime, data: bytes.toString('base64') } });
  }
  return parts;
}

function normalizeGoogleThinkingLevel(effort: string | undefined): string {
  const raw = String(effort ?? 'high').trim().toUpperCase();
  if (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(raw)) return raw;
  return 'HIGH';
}

export function buildGoogleBody(request: Request, options: GenerateOptions = {}, media?: CompatMediaOptions, keepThinking = true): Record<string, unknown> {
  const entries = requestContext(request, options);
  const names = googleToolNames([...(request.tools ?? []).map(tool => tool.name), ...entries.flatMap(entry => entry.item.type === 'function_call' ? [entry.item.name] : [])]);
  const systems = request.instructions ? [request.instructions] : [];
  const contents: Content[] = [];
  const calls = new Map<string, { name: string; nativeId?: string }>();
  const native = new Map<string, NativeTurn>();
  const groups = new Map<string, ContextRecord[]>();
  const folded = new Set<string>();
  for (const entry of entries) {
    if (entry.context.responseId) {
      const group = groups.get(entry.context.responseId) ?? [];
      group.push(entry); groups.set(entry.context.responseId, group);
    }
    const turn = nativeTurn(entry, options, request.model);
    if (turn && entry.context.responseId) native.set(entry.context.responseId, turn);
    if (entry.item.type === 'function_call') calls.set(entry.item.call_id, { name: names.encode(entry.item.name) });
  }
  for (const [id, group] of groups) {
    const turn = native.get(id);
    const marker = group.some(entry => explicitlyFolded(entry) && sameOrigin(entry.context.origin, options.origin, request.model));
    if (turn && !matchesLocalTurn(turn, group)) {
      if (!marker) throw new ResponseProtocolError('Stored native model parts disagree with retained local history');
      native.delete(id); folded.add(id);
    } else if (!turn && marker) folded.add(id);
  }
  const emitted = new Set<string>();
  const carriesResponse = (parts: readonly Json[]): boolean => parts.some(part => 'functionResponse' in part);
  const textOnly = (parts: readonly Json[]): boolean => parts.some(part => !('functionResponse' in part));
  const append = (role: Content['role'], parts: Json[]): void => {
    if (!parts.length) return;
    const previous = contents.at(-1);
    if (!previous || previous.role !== role) { contents.push({ role, parts }); return; }
    if (carriesResponse(parts)) {
      if (carriesResponse(previous.parts) && !textOnly(previous.parts)) previous.parts.push(...parts);
      else contents.push({ role, parts });
    } else if (!carriesResponse(previous.parts)) previous.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const entry of entries) {
    const item = entry.item;
    const responseId = entry.context.responseId;
    const turn = responseId ? native.get(responseId) : undefined;
    if (turn && (item.type === 'reasoning' || item.type === 'function_call' || (item.type === 'message' && item.role === 'assistant'))) {
      if (!emitted.has(responseId!)) {
        append('model', structuredClone(turn.parts)); emitted.add(responseId!);
        for (const call of turn.calls) {
          const nativeCall = turn.parts[call.index]?.functionCall;
          if (!nativeCall?.name) throw new ResponseProtocolError('Stored native function association is unreadable');
          calls.set(call.callId, { name: nativeCall.name, ...(nativeCall.id ? { nativeId: nativeCall.id } : {}) });
        }
      }
      continue;
    }
    if (item.type === 'reasoning') {
      const text = itemText(item);
      if (keepThinking && text && sameOrigin(entry.context.origin, options.origin, request.model)) {
        append('model', [{ text, thought: true }]);
      }
    } else if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') systems.push(itemText(item));
      else append(item.role === 'assistant' ? 'model' : 'user', inputParts(entry, media));
    } else if (item.type === 'function_call') {
      if (sameOrigin(entry.context.origin, options.origin, request.model) && !folded.has(responseId ?? '') && item.arguments !== FOLD_ARGS_PLACEHOLDER)
        throw new ResponseProtocolError('Native function history is missing its original signed model parts');
      append('model', [{ functionCall: { name: names.encode(item.name), args: historicalArguments(item.arguments) }, thoughtSignature: SYNTHETIC_SIGNATURE }]);
    } else if (item.type === 'function_call_output') {
      const call = calls.get(item.call_id);
      if (!call) throw new ResponseProtocolError(`Function result has no matching call: ${item.call_id}`);
      const images = inputParts(entry, media).filter(part => !('text' in part));
      append('user', [{ functionResponse: { name: call.name, response: { output: itemText(item) }, ...(call.nativeId ? { id: call.nativeId } : {}) } }, ...images]);
    } else throw new ResponseProtocolError(`Cannot replay native input item: ${item.type}`);
  }
  if (contents.at(-1)?.role === 'model') contents.push({ role: 'user', parts: [{ text: '继续' }] });
  const body: Json = { contents };
  if (systems.length) body.systemInstruction = { parts: systems.filter(Boolean).map(text => ({ text })) };
  if (request.tools?.length) {
    body.tools = [{ functionDeclarations: request.tools.map(tool => ({ name: names.encode(tool.name),
      ...(tool.description ? { description: tool.description } : {}), ...(tool.parameters ? { parametersJsonSchema: tool.parameters } : {}) })) }];
    const choice = request.tool_choice;
    const config: Json = { mode: choice === 'required' ? 'ANY' : choice === 'none' ? 'NONE' : 'AUTO' };
    if (choice && typeof choice === 'object') {
      if (choice.type === 'function') {
        if (!choice.name) throw new ResponseProtocolError('Function choice has no name');
        config.mode = 'ANY'; config.allowedFunctionNames = [names.encode(choice.name)];
      } else {
        config.mode = choice.mode === 'required' ? 'ANY' : 'AUTO';
        config.allowedFunctionNames = choice.tools.map(tool => { if (!tool.name) throw new ResponseProtocolError('Function choice has no name'); return names.encode(tool.name); });
      }
    }
    body.toolConfig = { functionCallingConfig: config };
  }
  const spec = requestSpec(request, options);
  const generation: Json = {};
  const fixedSampling = /^gemini-4(?:[.-]|$)/i.test(spec.model);
  if (!fixedSampling && spec.temperature !== undefined) generation.temperature = spec.temperature;
  if (spec.maxTokens !== undefined) generation.maxOutputTokens = spec.maxTokens;
  if (!fixedSampling && request.top_p !== undefined && request.top_p !== null) generation.topP = request.top_p;
  generation.thinkingConfig = { includeThoughts: true, thinkingLevel: normalizeGoogleThinkingLevel(spec.reasoningEffort) };
  const format = request.text?.format;
  if (format?.type === 'json_schema') {
    generation.responseMimeType = 'application/json';
    if (format.type === 'json_schema' && format.schema) generation.responseJsonSchema = format.schema;
  }
  body.generationConfig = generation;
  return body;
}

function quantity(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
export function googleMeters(raw: Json | undefined): TokenMeters {
  if (!raw) return unknownMeters();
  const input = quantity(raw.promptTokenCount), candidates = quantity(raw.candidatesTokenCount), reasoning = quantity(raw.thoughtsTokenCount);
  const total = quantity(raw.totalTokenCount);
  const cachedInput = quantity(raw.cachedContentTokenCount) ?? (input !== null ? 0 : null);
  const output = candidates !== null ? candidates + (reasoning ?? 0) : null;
  return { input, output, total, cachedInput, uncachedInput: input !== null && cachedInput !== null ? input - cachedInput : null,
    reasoning: reasoning ?? (candidates !== null ? 0 : null), native: structuredClone(raw) };
}

type MutableItem = Json & { id: string; type: string; content?: Json[]; summary?: Json[] };
/** Native chunks retain their model parts for signed, lossless replay on a later tool turn. */
export class GoogleResponseAssembly implements ResponseAssembly {
  private readonly response: Response;
  private readonly accumulator = new ResponseAccumulator();
  private readonly output: MutableItem[] = [];
  private readonly parts: Json[] = [];
  private readonly calls: NativeTurn['calls'] = [];
  private readonly names: ReturnType<typeof googleToolNames>;
  private readonly slots = new Map<string, number>();
  private sequence = 0;
  private started = false;
  private finished = false;
  private reason: string | undefined;
  private usage = unknownMeters();
  constructor(request: Request, _options: GenerateOptions = {}) {
    this.response = createResponse(`resp_${randomUUID()}`, request);
    this.names = googleToolNames((request.tools ?? []).map(tool => tool.name));
  }
  private send(value: Json, emit: (event: StreamEvent) => void): void {
    const event = structuredClone({ ...value, sequence_number: this.sequence++ }) as StreamEvent;
    this.accumulator.accept(event); emit(event);
  }
  private add(item: MutableItem, emit: (event: StreamEvent) => void): number {
    const index = this.output.length; this.output.push(item);
    this.send({ type: 'response.output_item.added', output_index: index, item }, emit); return index;
  }
  private text(text: string, thought: boolean, emit: (event: StreamEvent) => void): void {
    const kind = thought ? 'reasoning' : 'message';
    let index = this.slots.get(kind);
    if (index === undefined) {
      index = this.add(thought ? { type: 'reasoning', id: `rs_${randomUUID()}`, summary: [], content: [] }
        : { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] }, emit);
      this.slots.set(kind, index);
      const part = thought ? { type: 'reasoning_text', text: '' } : { type: 'output_text', text: '', annotations: [] };
      this.send({ type: 'response.content_part.added', output_index: index, item_id: this.output[index].id, content_index: 0, part }, emit);
      this.output[index].content = [part];
    }
    const item = this.output[index];
    this.send({ type: thought ? 'response.reasoning.delta' : 'response.output_text.delta', output_index: index, item_id: item.id,
      content_index: 0, delta: text, ...(!thought ? { logprobs: [] } : {}) }, emit);
    item.content![0].text += text;
  }
  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    if (this.finished) throw new ResponseProtocolError('Native chunk after completion');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ResponseProtocolError('Invalid native model chunk');
    const chunk = payload as Json;
    if (chunk.error) throw new ResponseProtocolError(`Native model error: ${chunk.error.message ?? chunk.error.status ?? 'unknown'}`);
    if (!this.started) {
      if (typeof chunk.responseId === 'string') this.response.id = chunk.responseId;
      if (typeof chunk.modelVersion === 'string') this.response.model = chunk.modelVersion;
      this.send({ type: 'response.created', response: this.response }, emit); this.started = true;
    }
    if (chunk.usageMetadata) this.usage = googleMeters(chunk.usageMetadata);
    if (chunk.promptFeedback?.blockReason) this.reason = 'SAFETY';
    const candidates = chunk.candidates;
    if (candidates !== undefined && !Array.isArray(candidates)) throw new ResponseProtocolError('Native candidates must be an array');
    if (candidates?.length > 1 || candidates?.[0]?.index > 0) throw new ResponseProtocolError('Multiple native candidates are unsupported');
    const candidate = candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) this.reason = candidate.finishReason;
    for (const value of candidate.content?.parts ?? []) {
      if (!value || typeof value !== 'object') throw new ResponseProtocolError('Invalid native model part');
      const part = structuredClone(value) as Json;
      if (part.thoughtSignature !== undefined && (typeof part.thoughtSignature !== 'string' || !part.thoughtSignature)) {
        throw new ResponseProtocolError('Invalid native thoughtSignature');
      }
      if (part.text === '' && !part.thoughtSignature && !part.functionCall
        && Object.keys(part).every(key => key === 'text' || key === 'thought')) {
        continue;
      }
      const partIndex = this.parts.length; this.parts.push(part);
      if (typeof part.text === 'string' && part.text) this.text(part.text, part.thought === true, emit);
      if (part.functionCall) {
        const call = part.functionCall;
        if (typeof call.name !== 'string' || !call.args || typeof call.args !== 'object' || Array.isArray(call.args))
          throw new ResponseProtocolError('Native function call lacks its name or argument object');
        const callId = typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID()}`;
        const name = this.names.decode(call.name);
        const index = this.add({ type: 'function_call', id: `fc_${randomUUID()}`, call_id: callId, name, arguments: '', status: 'in_progress' }, emit);
        const item = this.output[index]; const args = JSON.stringify(call.args);
        this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: args }, emit);
        item.arguments = args; this.calls.push({ index: partIndex, callId, name });
      } else if (!('text' in part) && !part.thoughtSignature) throw new ResponseProtocolError('Unsupported native model output part');
    }
  }
  finish(emit: (event: StreamEvent) => void): Response {
    if (!this.started || !this.reason) throw new ResponseProtocolError('Native transport ended without finishReason');
    if (this.finished) throw new ResponseProtocolError('Native response completed twice');
    this.finished = true;
    const incomplete = this.reason === 'MAX_TOKENS' || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(this.reason);
    if (!incomplete && this.reason !== 'STOP') throw new ResponseProtocolError(`Native model stopped with ${this.reason}`);
    if (this.parts.length) this.add({ type: 'reasoning', id: `rs_${randomUUID()}`, summary: [],
      encrypted_content: SIGNATURE_PREFIX + Buffer.from(JSON.stringify({ parts: this.parts, calls: this.calls } satisfies NativeTurn)).toString('base64') }, emit);
    for (let index = 0; index < this.output.length; index++) {
      const item = this.output[index];
      if (item.type === 'function_call') this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments }, emit);
      else if (item.content?.length) this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part: item.content[0] }, emit);
      if (item.type !== 'reasoning') item.status = incomplete ? 'incomplete' : 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    }
    this.response.output = this.output as OutputItem[];
    this.response.status = incomplete ? 'incomplete' : 'completed';
    this.response.completed_at = Math.floor(Date.now() / 1000);
    this.response.incomplete_details = incomplete ? { reason: this.reason === 'MAX_TOKENS' ? 'max_output_tokens' : 'content_filter' } : null;
    this.response.usage = standardUsage(this.usage);
    this.send({ type: `response.${this.response.status}`, response: this.response }, emit);
    return this.accumulator.finish();
  }
  snapshot(): Response | null { return this.accumulator.snapshot(); }
  meters(): TokenMeters { return structuredClone(this.usage); }
  serviceTier(): string | null { return null; }
}

export function parseGoogleResponse(raw: unknown, request: Request, options: GenerateOptions = {}): { response: Response; meters: TokenMeters; serviceTier: string | null } {
  const assembly = new GoogleResponseAssembly(request, options);
  assembly.feed(raw, () => {});
  return { response: assembly.finish(() => {}), meters: assembly.meters(), serviceTier: assembly.serviceTier() };
}
