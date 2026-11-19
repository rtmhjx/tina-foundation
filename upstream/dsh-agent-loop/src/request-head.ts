/** Request-only, lifecycle-owned context preceding durable conversation history. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, MessageId, LlmCallConfig, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, Session, SessionId } from '@deepseek-ai/dsh-session'

export const DEFAULT_MAX_REQUEST_HEAD_TOKENS = 32768
export interface RequestHeadContext { agent: Agent; turn: number; step: number; signal: AbortSignal; config: LlmCallConfig; preparedCall?: PreparedLlmCall }
export interface RequestHeadValue { messages: readonly Message[]; revision?: string }
export interface RequestHeadRegistration {
  id: string
  sessionId: SessionId
  provide(context: RequestHeadContext): RequestHeadValue | Promise<RequestHeadValue>
  /** Synchronous semantic revision for dynamic providers, used by maintenance guards. */
  currentRevision?(): string | number
}
export interface RequestHeadBudget {
  estimator: 'native-fixed-density-v1'
  headTokens: number
  surfaceTokens: number
  toolsTokens: number
  outputReserve: number
  estimatedTokens: number
  maxHeadTokens: number
  contextWindow?: number
  enforcement: 'context-window' | 'head-limit-only' | 'empty-head'
}
export interface RequestHeadSnapshot {
  version: 1
  sessionId: SessionId
  turn: number
  step: number
  providers: Array<{ id: string; revision?: string }>
  messages: Message[]
  digest: string
  budget?: RequestHeadBudget
}
declare module '@deepseek-ai/dsh-session' {
  interface RequestContext {
    /** Log-only audit of this request; never restored as a provider or surface node. */
    requestHead?: RequestHeadSnapshot
  }
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code: string, text: string): never => { throw new LlmError(text, code) }
const snapshotDigest = (head: Pick<RequestHeadSnapshot, 'providers' | 'messages'>): string => digest({ providers: head.providers, messages: head.messages })

/** Same fixed-density heuristic as the native token meter, without usage anchors. */
export function estimateRequestMessage(message: Message): number {
  const content = (blocks: readonly ContentBlock[]): number => blocks.reduce((sum, block) => {
    switch (block.type) {
      case 'text': case 'reasoning': return sum + Math.ceil(block.text.length / 4) + 4
      case 'tool-call': return sum + Math.ceil(block.name.length / 4) + Math.ceil(block.arguments.length / 4) + 4
      case 'tool-result': return sum + content(block.content) + 4
      default: return sum + Math.ceil(JSON.stringify(block).length / 4) + 4
    }
  }, 0)
  if (message.role !== 'system') return content(message.content) + 4
  if (!message.content.length) return 0
  return Math.ceil(message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : JSON.stringify(block).length), 0) / 4) + 4
}

/** Filter authority roles and close tool exchanges entirely within one provider. */
function normalize(value: RequestHeadValue, providerId: string, sessionId: SessionId): Message[] {
  if (!value || !Array.isArray(value.messages) || (value.revision !== undefined && typeof value.revision !== 'string')) fail('REQUEST_HEAD_INVALID', 'A request head provider returned an invalid value.')
  const result: Message[] = []
  const pending = new Map<string, Extract<ContentBlock, { type: 'tool-call' }>>()
  const seenCalls = new Set<string>()
  const seenIds = new Set<string>()
  const source = { kind: 'plugin' as const, plugin: 'request-head/' + providerId, form: 'recall' as const }
  const idFor = (id: string): MessageId => ('request-head-' + digest([sessionId, providerId, id])) as MessageId
  const close = (): void => {
    for (const [id] of pending) result.push(freezeMessage({ id: idFor('missing-result:' + id), role: 'user', source,
      content: [{ type: 'tool-result', toolCallId: id as Extract<ContentBlock, { type: 'tool-call' }>['id'], isError: true,
        content: [{ type: 'text', text: 'This request-only example did not include a tool result.' }] }] }))
    pending.clear()
  }
  for (const raw of value.messages) {
    if (!raw || typeof raw !== 'object') fail('REQUEST_HEAD_INVALID', 'A request head contains an invalid message.')
    if (raw.role === 'system' || (raw.role as string) === 'developer') continue
    if (!['user', 'assistant'].includes(raw.role) || typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.content)) fail('REQUEST_HEAD_INVALID', 'A request head message has an invalid role, identity or content.')
    if (seenIds.has(raw.id)) fail('REQUEST_HEAD_ID_COLLISION', 'A request head provider reused a message identity.')
    seenIds.add(raw.id)
    if (raw.role === 'user') {
      const plain: ContentBlock[] = []
      for (const block of raw.content) {
        if (!block || typeof block.type !== 'string') fail('REQUEST_HEAD_INVALID', 'A request head contains an invalid content block.')
        if (block.type === 'tool-call') fail('REQUEST_HEAD_INVALID', 'A user request head cannot contain a tool call.')
        if (block.type === 'tool-result') {
          if (!pending.delete(block.toolCallId)) continue
          if (!Array.isArray(block.content)) fail('REQUEST_HEAD_INVALID', 'A request head contains an invalid tool result.')
          result.push(freezeMessage({ id: idFor(raw.id + ':tool-result:' + block.toolCallId), role: 'user', source, content: [block] }))
        } else {
          if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text !== 'string') fail('REQUEST_HEAD_INVALID', 'A request head contains invalid text.')
          plain.push(block)
        }
      }
      if (plain.length) { close(); result.push(freezeMessage({ id: idFor(raw.id), role: 'user', content: plain, source })) }
      continue
    }
    const content: ContentBlock[] = []
    close()
    for (const block of raw.content) {
      if (!block || typeof block.type !== 'string') fail('REQUEST_HEAD_INVALID', 'A request head contains an invalid content block.')
      if (block.type === 'tool-call') {
        if (raw.role !== 'assistant' || typeof block.id !== 'string' || typeof block.name !== 'string' || typeof block.arguments !== 'string') fail('REQUEST_HEAD_INVALID', 'A request head contains an invalid tool call.')
        if (seenCalls.has(block.id)) fail('REQUEST_HEAD_CALL_COLLISION', 'A request head reused a tool call identity.')
        seenCalls.add(block.id); pending.set(block.id, block)
      } else if (block.type === 'tool-result') {
        continue
      } else if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text !== 'string') fail('REQUEST_HEAD_INVALID', 'A request head contains invalid text.')
      content.push(block)
    }
    if (content.length) result.push(freezeMessage({ id: idFor(raw.id), role: raw.role, content, source }))
  }
  close()
  return result
}

/** One registry per AgentLoop instance; every registration belongs to its caller's Fiber. */
export class RequestHeadRegistry {
  private entries = new Map<string, { registration: RequestHeadRegistration; active: boolean }>()
  private generations = new Map<SessionId, number>()
  private changed(sessionId: SessionId): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
  }
  revision(sessionId: SessionId): string {
    const values = [...this.entries.values()].filter(entry => entry.active && entry.registration.sessionId === sessionId)
      .map(entry => {
        const revision = entry.registration.currentRevision?.()
        if (revision !== undefined && typeof revision !== 'string' && typeof revision !== 'number') fail('REQUEST_HEAD_REVISION_INVALID', 'A request head revision must be synchronous text or a number.')
        return [entry.registration.id, revision]
      })
    return digest([this.generations.get(sessionId) ?? 0, values])
  }
  register(ctx: Context, registration: RequestHeadRegistration): () => void {
    if (!registration || typeof registration.id !== 'string' || !registration.id || typeof registration.sessionId !== 'string' || typeof registration.provide !== 'function') fail('REQUEST_HEAD_REGISTRATION_INVALID', 'A request head registration needs an id, sessionId and provider.')
    const key = registration.sessionId + '\0' + registration.id
    if (this.entries.has(key)) fail('REQUEST_HEAD_REGISTRATION_CONFLICT', 'A request head provider identity is already registered for this session.')
    const entry = { registration: { ...registration }, active: true }
    return ctx.effect(() => {
      this.entries.set(key, entry)
      this.changed(registration.sessionId)
      return () => {
        entry.active = false
        if (this.entries.get(key) === entry) { this.entries.delete(key); this.changed(registration.sessionId) }
      }
    }, 'agentLoop.requestHead()')
  }
  async assemble(context: RequestHeadContext): Promise<RequestHeadSnapshot | undefined> {
    const entries = [...this.entries.values()].filter(entry => entry.active && entry.registration.sessionId === context.agent.session.id)
    if (!entries.length) return undefined
    const providers: RequestHeadSnapshot['providers'] = []
    const messages: Message[] = []
    for (const entry of entries) {
      context.signal.throwIfAborted()
      const value = await entry.registration.provide(context)
      context.signal.throwIfAborted()
      if (!entry.active) continue
      const normalized = normalize(value, entry.registration.id, context.agent.session.id)
      providers.push({ id: entry.registration.id, ...value.revision === undefined ? {} : { revision: value.revision } })
      messages.push(...normalized)
    }
    const head: RequestHeadSnapshot = { version: 1, sessionId: context.agent.session.id, turn: context.turn, step: context.step, providers, messages, digest: snapshotDigest({ providers, messages }) }
    return head
  }
}

/** Canonical reconstruction for both AgentLoop and its native invariant companion. */
export function deriveRequestMessages(session: Session, head = session.requestContext()?.requestHead): Message[] {
  const surface = session.deriveMessages()
  if (!head) return surface
  if (head.version !== 1 || head.sessionId !== session.id || head.digest !== snapshotDigest(head)) fail('REQUEST_HEAD_AUDIT_INVALID', 'The request head audit snapshot is invalid.')
  const ids = new Set(surface.map(message => message.id))
  const calls = new Set(surface.flatMap(message => message.content.filter(block => block.type === 'tool-call').map(block => block.id)))
  const providerIds = new Set(head.providers.map(provider => 'request-head/' + provider.id))
  for (const message of head.messages) {
    if (!['user', 'assistant'].includes(message.role) || message.source.kind !== 'plugin' || !providerIds.has(message.source.plugin)) fail('REQUEST_HEAD_AUDIT_INVALID', 'The request head has an invalid authority source.')
    if (ids.has(message.id)) fail('REQUEST_HEAD_ID_COLLISION', 'Request head and surface message identities collide.')
    ids.add(message.id)
    for (const block of message.content) if (block.type === 'tool-call') {
      if (calls.has(block.id)) fail('REQUEST_HEAD_CALL_COLLISION', 'Request head and surface tool call identities collide.')
      calls.add(block.id)
    }
  }
  let at = 0
  while (surface[at]?.role === 'system') at++
  return [...surface.slice(0, at), ...head.messages, ...surface.slice(at)]
}

/** Record complete-request pressure; enforce only requests carrying a non-empty head. */
export function priceRequestHead(session: Session, head: RequestHeadSnapshot, header: EpochHeader, contextWindow: number | undefined, maxHeadTokens: number): RequestHeadSnapshot {
  const headTokens = head.messages.reduce((sum, message) => sum + estimateRequestMessage(message), 0)
  const surfaceTokens = session.deriveMessages().reduce((sum, message) => sum + estimateRequestMessage(message), 0)
  const toolsTokens = header.tools?.length ? Math.ceil(JSON.stringify(header.tools).length / 4) + 4 : 0
  const outputReserve = header.config.maxTokens ?? 0
  const knownWindow = Number.isSafeInteger(contextWindow) && contextWindow! > 0 ? contextWindow : undefined
  return { ...head, budget: { estimator: 'native-fixed-density-v1', headTokens, surfaceTokens, toolsTokens, outputReserve,
    estimatedTokens: headTokens + surfaceTokens + toolsTokens + outputReserve, maxHeadTokens,
    ...knownWindow === undefined ? {} : { contextWindow: knownWindow },
    enforcement: headTokens === 0 ? 'empty-head' : knownWindow === undefined ? 'head-limit-only' : 'context-window' } }
}
export function assertRequestHeadBudget(head: RequestHeadSnapshot | undefined): void {
  const budget = head?.budget
  if (!budget || budget.headTokens === 0) return
  if (budget.headTokens > budget.maxHeadTokens) fail('HEAD_CONTEXT_BUDGET_EXCEEDED', `Request head needs ${budget.headTokens} estimated tokens; configured head limit is ${budget.maxHeadTokens}.`)
  if (budget.contextWindow !== undefined && budget.estimatedTokens > budget.contextWindow) fail('REQUEST_CONTEXT_BUDGET_EXCEEDED', `Request needs ${budget.estimatedTokens} estimated tokens including head, surface, tools and output reserve; context window is ${budget.contextWindow}.`)
}
