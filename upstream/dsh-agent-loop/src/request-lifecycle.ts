/** Awaited process-local boundaries; these do not extend the durable journal format. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { GenerateOptions, FinishReason } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, RequestContext, SessionSeq } from '@deepseek-ai/dsh-session'

interface RequestLifecycle {
  agent: Agent
  requestId: string
  turn: number
  step: number
  request: GenerateOptions
  signal: AbortSignal
}

export interface PlannedRequest extends RequestLifecycle {
  requestHeader: EpochHeader
  requestContext: RequestContext | undefined
  surfaceSeqs: readonly SessionSeq[]
  generation: number
  /** Valid until surface, request derivation, route selection or registrations change. */
  revalidate(): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Exact built request before budget admission; maintenance may invalidate it, requiring a rebuild. */
    'agent/request-planning'(this: Scoped<Agent>, payload: PlannedRequest): void | Promise<void>
    /** Final non-bailing validation for every normal turn completion. */
    'agent/turn-completing'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): void | Promise<void>
    /** Final immutable request, before dispatch. A listener may persist a receipt or veto. */
    'agent/request-ready'(this: Scoped<Agent>, payload: RequestLifecycle): void | Promise<void>
    /** Successful assistant event appended, before tools. Persistence must be awaited by receipt owners. */
    'agent/response-committed'(this: Scoped<Agent>, payload: RequestLifecycle & {
      assistantSeq: SessionSeq
      finish: FinishReason
    }): void | Promise<void>
  }
}
