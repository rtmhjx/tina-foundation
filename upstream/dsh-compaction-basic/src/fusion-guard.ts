/** Session-scoped opt-in seam; foreign sessions retain the unmodified backend. */
export interface FusionCompactionPlan {
  readonly sessionId: string
  readonly compactionId: string
  readonly start: number
  readonly end: number
  readonly shadowedSeqs: readonly number[]
  readonly retainedSeqs: readonly number[]
  readonly visibleSeqs: readonly number[]
  readonly surfaceGeneration: number
  readonly summary: unknown
  readonly checkpointMessage: unknown
}

/** Revalidation must synchronously inspect the current unpresented-input set. */
export interface FusionPlanPermit { readonly allow: boolean; readonly revalidate: () => boolean }
export type FusionPlanGuard = (plan: FusionCompactionPlan) => Promise<FusionPlanPermit> | FusionPlanPermit
export interface FusionCompactionInvocation {
  readonly agent: any
  readonly trigger: 'pressure' | 'context-overflow' | 'manual'
  readonly boundary: 'open-turn' | 'idle'
  readonly signal: AbortSignal
  readonly sourceCommandId?: unknown
  /** Additional pre-step inputs which have not yet been appended to surface. */
  readonly requestPreview?: unknown
  readonly runNative: (guard: FusionPlanGuard, options?: { additionalTokens?: number; thresholdTokens?: number; requestHeader?: unknown; requestContext?: unknown; target?: { provider: string; model: string }; protectedNativeSeqs?: readonly number[]; summaryInstruction?: string }) => Promise<any>
}
export interface FusionCompactionCoordinator {
  interceptCompaction(invocation: FusionCompactionInvocation): Promise<any>
}

interface Registration {
  readonly policy: FusionCompactionCoordinator
  readonly pending: Set<Promise<unknown>>
  closing: boolean
}
const coordinators = new WeakMap<object, Registration>()
const activeGuards = new WeakMap<object, { guard: FusionPlanGuard; additionalTokens: number; thresholdTokens?: number; requestHeader?: unknown; requestContext?: unknown; target?: { provider: string; model: string }; protectedNativeSeqs?: readonly number[]; summaryInstruction?: string }>()

export function hasFusionCompactionCoordinator(session: object): boolean {
  return coordinators.has(session)
}

/** Only the exact native Session object is enrolled. Disposing cannot remove a later owner. */
export function registerFusionCompactionCoordinator(session: object, policy: FusionCompactionCoordinator): () => Promise<void> {
  if (!session || typeof policy?.interceptCompaction !== 'function') throw new TypeError('Invalid compaction coordinator')
  if (coordinators.has(session)) throw new Error('A compaction coordinator is already registered for this session')
  const registration: Registration = { policy, pending: new Set(), closing: false }
  coordinators.set(session, registration)
  return async () => {
    registration.closing = true
    await Promise.allSettled([...registration.pending])
    if (coordinators.get(session) === registration) coordinators.delete(session)
  }
}

export function fusionGuardFor(session: object): FusionPlanGuard | undefined {
  const active = activeGuards.get(session)
  if (!active && coordinators.has(session)) {
    throw Object.assign(new Error('Coordinated session requires a compaction plan guard'), { code: 'FUSION_COMPACTION_GUARD_REQUIRED' })
  }
  return active?.guard
}

export function fusionAdditionalTokensFor(session: object): number {
  return activeGuards.get(session)?.additionalTokens ?? 0
}
export function fusionTargetFor(session: object): { provider: string; model: string } | undefined {
  return activeGuards.get(session)?.target
}
export function fusionThresholdFor(session: object): number | undefined { return activeGuards.get(session)?.thresholdTokens }
export function fusionHeaderFor(session: object): unknown { return activeGuards.get(session)?.requestHeader }
export function fusionContextFor(session: object): unknown { return activeGuards.get(session)?.requestContext }
export function fusionSummaryInstructionFor(session: object): string | undefined { return activeGuards.get(session)?.summaryInstruction }
export function fusionProtectedFor(session: object): readonly number[] { return activeGuards.get(session)?.protectedNativeSeqs ?? [] }

export async function routeFusionCompaction(
  agent: any, trigger: FusionCompactionInvocation['trigger'], boundary: FusionCompactionInvocation['boundary'],
  signal: AbortSignal, sourceCommandId: unknown, run: () => Promise<any>, requestPreview?: unknown,
): Promise<any> {
  const session = agent.session as object
  const registration = coordinators.get(session)
  if (!registration) return run()
  if (registration.closing) throw Object.assign(new Error('Compaction coordinator is closing'), { code: 'FUSION_COMPACTION_CLOSING' })
  let called = false
  let nativeTask: Promise<any> | undefined
  const operation = Promise.resolve().then(async () => {
    try { return await registration.policy.interceptCompaction({ agent, trigger, boundary, signal,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    ...(requestPreview ? { requestPreview } : {}),
    runNative: (guard, options) => {
      const task = (async () => {
      if (called) throw new Error('A native compaction invocation may run only once')
      if (typeof guard !== 'function') throw Object.assign(new Error('A compaction plan guard is required'), { code: 'FUSION_COMPACTION_GUARD_REQUIRED' })
      if (activeGuards.has(session)) throw Object.assign(new Error('A compaction is already active for this session'), { code: 'FUSION_COMPACTION_BUSY' })
      const additionalTokens = options?.additionalTokens ?? 0
      if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 0) throw new TypeError('Invalid additional request token estimate')
      const thresholdTokens = options?.thresholdTokens
      if (thresholdTokens !== undefined && (!Number.isSafeInteger(thresholdTokens) || thresholdTokens < 1)) throw new TypeError('Invalid compaction threshold')
      const target = options?.target
      if (target !== undefined && (typeof target.provider !== 'string' || !target.provider || typeof target.model !== 'string' || !target.model)) throw new TypeError('Invalid request target')
      const protectedNativeSeqs = options?.protectedNativeSeqs
      if (protectedNativeSeqs !== undefined && (!Array.isArray(protectedNativeSeqs) || protectedNativeSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0))) throw new TypeError('Invalid protected native sequences')
      if (options?.summaryInstruction !== undefined && typeof options.summaryInstruction !== 'string') throw new TypeError('Invalid summary instruction')
      called = true
      const active = { guard, additionalTokens, ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
        ...(options?.requestHeader === undefined ? {} : { requestHeader: options.requestHeader }), ...(target ? { target: { ...target } } : {}),
        ...(options?.requestContext === undefined ? {} : { requestContext: options.requestContext }),
        ...(options?.summaryInstruction === undefined ? {} : { summaryInstruction: options.summaryInstruction }),
        ...(protectedNativeSeqs === undefined ? {} : { protectedNativeSeqs: [...protectedNativeSeqs] }) }
      activeGuards.set(session, active)
      try { return await run() } finally { if (activeGuards.get(session) === active) activeGuards.delete(session) }
      })()
      if (called && !nativeTask) nativeTask = task
      return task
    },
    }) } finally { if (nativeTask) await nativeTask.catch(() => {}) }
  })
  registration.pending.add(operation)
  try { return await operation } finally { registration.pending.delete(operation) }
}
