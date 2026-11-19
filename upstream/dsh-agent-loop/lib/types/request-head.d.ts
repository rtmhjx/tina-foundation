import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Message, LlmCallConfig, PreparedLlmCall } from '@deepseek-ai/dsh-llm';
import type { EpochHeader, Session, SessionId } from '@deepseek-ai/dsh-session';
export declare const DEFAULT_MAX_REQUEST_HEAD_TOKENS = 32768;
export interface RequestHeadContext {
    agent: Agent;
    turn: number;
    step: number;
    signal: AbortSignal;
    config: LlmCallConfig;
    preparedCall?: PreparedLlmCall;
}
export interface RequestHeadValue {
    messages: readonly Message[];
    revision?: string;
}
export interface RequestHeadRegistration {
    id: string;
    sessionId: SessionId;
    provide(context: RequestHeadContext): RequestHeadValue | Promise<RequestHeadValue>;
    /** Synchronous semantic revision for dynamic providers, used by maintenance guards. */
    currentRevision?(): string | number;
}
export interface RequestHeadBudget {
    estimator: 'native-fixed-density-v1';
    headTokens: number;
    surfaceTokens: number;
    toolsTokens: number;
    outputReserve: number;
    estimatedTokens: number;
    maxHeadTokens: number;
    contextWindow?: number;
    enforcement: 'context-window' | 'head-limit-only' | 'empty-head';
}
export interface RequestHeadSnapshot {
    version: 1;
    sessionId: SessionId;
    turn: number;
    step: number;
    providers: Array<{
        id: string;
        revision?: string;
    }>;
    messages: Message[];
    digest: string;
    budget?: RequestHeadBudget;
}
declare module '@deepseek-ai/dsh-session' {
    interface RequestContext {
        /** Log-only audit of this request; never restored as a provider or surface node. */
        requestHead?: RequestHeadSnapshot;
    }
}
/** Same fixed-density heuristic as the native token meter, without usage anchors. */
export declare function estimateRequestMessage(message: Message): number;
/** One registry per AgentLoop instance; every registration belongs to its caller's Fiber. */
export declare class RequestHeadRegistry {
    private entries;
    private generations;
    private changed;
    revision(sessionId: SessionId): string;
    register(ctx: Context, registration: RequestHeadRegistration): () => void;
    assemble(context: RequestHeadContext): Promise<RequestHeadSnapshot | undefined>;
}
/** Canonical reconstruction for both AgentLoop and its native invariant companion. */
export declare function deriveRequestMessages(session: Session, head?: RequestHeadSnapshot | undefined): Message[];
/** Record complete-request pressure; enforce only requests carrying a non-empty head. */
export declare function priceRequestHead(session: Session, head: RequestHeadSnapshot, header: EpochHeader, contextWindow: number | undefined, maxHeadTokens: number): RequestHeadSnapshot;
export declare function assertRequestHeadBudget(head: RequestHeadSnapshot | undefined): void;
//# sourceMappingURL=request-head.d.ts.map