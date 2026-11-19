/** Optional, session-scoped host ownership. No route is installed by default. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionWireEvent, SessionAssistantStreamFrame } from './types.ts'

export interface HostPromptCall {
  readonly request: SessionPromptRequest
  readonly message: UserMessage
  readonly agent: Agent
}
export type HostPromptRoute = (call: HostPromptCall) => Promise<void>
export interface HostHistoryPresentation {
  /** Must preserve one output event per input event and its seq/time. */
  readonly event?: (event: SessionWireEvent) => SessionWireEvent
  readonly stream?: (frame: SessionAssistantStreamFrame) => SessionAssistantStreamFrame | null
  readonly baseline?: <T extends { revision: number }>(baseline: T) => T
}

/** Leases are identity-owned. Unrelated Sessions always retain native behavior. */
export class SessionHostRoutes {
  private readonly prompts = new Map<SessionId, HostPromptRoute>()
  private readonly presentations = new Map<SessionId, HostHistoryPresentation>()

  registerPrompt(sessionId: SessionId, route: HostPromptRoute): () => void {
    if (this.prompts.has(sessionId)) throw new Error('HOST_PROMPT_ROUTE_OWNED: ' + sessionId)
    this.prompts.set(sessionId, route)
    return () => { if (this.prompts.get(sessionId) === route) this.prompts.delete(sessionId) }
  }

  registerPresentation(sessionId: SessionId, presentation: HostHistoryPresentation): () => void {
    if (this.presentations.has(sessionId)) throw new Error('HOST_PRESENTATION_OWNED: ' + sessionId)
    this.presentations.set(sessionId, presentation)
    return () => { if (this.presentations.get(sessionId) === presentation) this.presentations.delete(sessionId) }
  }

  async prompt(call: HostPromptCall): Promise<boolean> {
    const route = this.prompts.get(call.request.sessionId)
    if (route === undefined) return false
    await route(call)
    return true
  }

  event(sessionId: SessionId, input: SessionEvent): SessionWireEvent {
    const event = input as unknown as SessionWireEvent
    const present = this.presentations.get(sessionId)?.event
    if (present === undefined) return event
    const result = present(structuredClone(event))
    if (result.seq !== event.seq || result.time !== event.time) {
      throw new Error('HOST_PRESENTATION_CURSOR_CHANGED: ' + sessionId)
    }
    return result
  }

  stream(sessionId: SessionId, frame: SessionAssistantStreamFrame): SessionAssistantStreamFrame | null {
    return this.presentations.get(sessionId)?.stream?.(frame) ??
      (this.presentations.get(sessionId)?.stream === undefined ? frame : null)
  }

  baseline<T extends { revision: number }>(sessionId: SessionId, baseline: T): T {
    return this.presentations.get(sessionId)?.baseline?.(baseline) ?? baseline
  }
}
