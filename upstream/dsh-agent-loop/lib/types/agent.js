/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */
import { agentEvents, agentCarrier, assembleContextFor } from '@deepseek-ai/dsh-agent';
import { LlmError, createAssistantMessage, errorChain, markAgentLoopRequest, CONTEXT_WINDOW_EXCEEDED_CODE, } from '@deepseek-ai/dsh-llm';
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values';
import { createScope } from '@deepseek-ai/dsh-scope';
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session';
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ReactLoopInbox } from "./inbox.js";
import { RuntimeContextProjection, isRuntimeContextMessage } from "./runtime-context.js";
import { AssistantStreamAttempt } from "./assistant-stream.js";
import { SystemPromptProjection } from "./runtime-context.js";
import { executeToolCalls } from "./tool-calls.js";
import { deriveRequestMessages, priceRequestHead, assertRequestHeadBudget } from "./request-head.js";
import { randomUUID } from 'node:crypto';
/** Project declared cancellation fields without transport decorations on the live abort reason. */
function durableCancelCause(cause) {
    switch (cause.kind) {
        case 'user': return { kind: 'user' };
        case 'parent': return { kind: 'parent' };
        case 'hook': return { kind: 'hook', reason: cause.reason };
        case 'disposed': return { kind: 'disposed' };
        default: return assertNever(cause);
    }
}
/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header) {
    if (header.adapterDefaults === undefined)
        return header.config;
    const proposal = { ...header.config };
    if (header.adapterDefaults.reasoningEffort === true)
        delete proposal.reasoningEffort;
    if (header.adapterDefaults.maxTokens === true)
        delete proposal.maxTokens;
    return proposal;
}
/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent {
    loopCtx;
    id;
    options;
    session;
    inbox;
    phase;
    activityDone = Promise.resolve();
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    scope;
    ctx;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    requestHeaderLogged = false;
    /** Surface generation at attachment or the preceding built request. */
    requestSurfaceGeneration;
    runtimeContext;
    /** Process-local revision of assistant frames for this attached Session. */
    assistantStreamRevision = 0;
    assistantAttemptCounter = 0;
    systemPrompt;
    /** Identities fully frozen by this loop; weak references do not retain replaced history. */
    frozenMessages = new WeakSet();
    requestConfigurationRevision = 0;
    constructor(loopCtx, id, options, session) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options;
        this.session = session;
        this.requestSurfaceGeneration = session.surface.replaceGeneration;
        this.dispatch = agentEvents(loopCtx, this);
        this.scope = createScope(loopCtx, this);
        this.ctx = this.scope.ctx;
        for (const event of ['system-prompt/change', 'tools/change', 'llm/adapters-updated']) {
            this.ctx.on(event, () => { this.requestConfigurationRevision++; }, { global: true });
        }
        this.ctx.on('session/event', (changed, event) => {
            if (changed === this.session && String(event.type) === 'model/selection')
                this.requestConfigurationRevision++;
        }, { global: true });
        this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch);
        /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
        const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0;
        this.phase = { kind: 'idle', lastTurn };
        this.runtimeContext = new RuntimeContextProjection(this.ctx, session);
        this.systemPrompt = new SystemPromptProjection(session);
    }
    get status() {
        return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running';
    }
    /** Commit a phase and publish its externally visible status transition. */
    setPhase(next) {
        const previousStatus = this.status;
        this.phase = next;
        const status = this.status;
        if (status !== previousStatus) {
            this.dispatch.emit('agent/status', { status });
        }
    }
    send(message, target, wakeup) {
        // Waking input cannot join an aborted activity, so it starts the next turn.
        // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
        const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted;
        const resolvedTarget = wakingAfterAbort ? 'next-turn' : target;
        this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
        if (wakeup)
            this.wakeDriver(wakingAfterAbort);
    }
    followup(input) {
        this.send(input, 'next-turn', true);
    }
    steer(input) {
        this.send(input, 'next-step', true);
    }
    inject(input) {
        this.send(input, 'next-step', false);
    }
    cancel(cause, options = {}) {
        try {
            // Dependency teardown can revoke the scope's projection before its
            // machine is stopped. There is no active inbox to clear in that case;
            // the session log remains authoritative for a later attachment.
            if (!options.keepInbox
                && this.loopCtx.get('sessionProjections')?.stateOf(this.session, 'inbox') !== undefined) {
                this.inbox.clear();
            }
        }
        finally {
            // A real projection/write failure still propagates, but must not leave
            // the driver running or a latched wake able to restart it during cleanup.
            if (this.phase.kind !== 'idle') {
                if (!options.keepInbox)
                    this.phase.wakeRequested = false;
                this.phase.abort.abort(cause);
            }
        }
    }
    runMaintenance(job) {
        if (this.phase.kind !== 'idle')
            throw new Error(`agent "${this.id}" already has active work`);
        const done = Promise.withResolvers();
        const maintenance = {
            kind: 'maintenance',
            abort: new AbortController(),
            lastTurn: this.phase.lastTurn,
            wakeRequested: false,
        };
        this.setPhase(maintenance);
        this.activityDone = done.promise;
        return (async () => {
            try {
                return await job(maintenance.abort.signal);
            }
            finally {
                this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn });
                if (maintenance.wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
                done.resolve();
            }
        })();
    }
    /**
     * Build a maintenance envelope over the already admitted native surface.
     * This is not a prediction of a future turn: pending input and unapplied
     * system/context edits remain pending. Current tools, route and request head
     * use the same resolver and canonical builder as ordinary model requests.
     * The caller must hold runMaintenance; no Provider call or body append occurs.
     */
    async prepareMaintenanceRequest(signal) {
        if (this.phase.kind !== 'maintenance') {
            throw new LlmError('A maintenance request requires the native maintenance boundary.', 'REQUEST_MAINTENANCE_REQUIRED');
        }
        const phase = this.phase;
        const combined = AbortSignal.any([signal, phase.abort.signal]);
        for (let attempt = 0; attempt < 8; attempt++) {
            combined.throwIfAborted();
            const configurationRevision = this.requestConfigurationRevision;
            const headRevision = this.loopCtx.agentLoop.requestHeadRevisionFor(this.session.id);
            const generation = this.session.surface.replaceGeneration;
            const nodes = JSON.stringify(this.session.surface.nodes);
            const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, combined));
            const { config, preparedCall } = await this.prepareRequest(0, 0, combined);
            const stable = () => this.phase === phase
                && configurationRevision === this.requestConfigurationRevision
                && headRevision === this.loopCtx.agentLoop.requestHeadRevisionFor(this.session.id)
                && generation === this.session.surface.replaceGeneration
                && nodes === JSON.stringify(this.session.surface.nodes);
            if (!stable())
                continue;
            const request = await this.buildRequest(config, preparedCall, assembly.tools, false, combined);
            if (!stable())
                continue;
            // Headers/context are normal native records, and must survive any later
            // coordinated surface replacement or process restart.
            if (!await this.loopCtx.sessions.flush(this.session)) {
                throw new LlmError('The maintenance request envelope was not persisted.', 'REQUEST_MAINTENANCE_PERSISTENCE');
            }
            if (!stable())
                continue;
            const plan = this.plannedRequest(request, 0, 0, combined);
            return Object.freeze({ ...plan, revalidate: () => this.phase === phase && plan.revalidate() });
        }
        throw new LlmError('Maintenance request configuration did not stabilize.', 'REQUEST_PLAN_UNSTABLE');
    }
    /**
     * Start one driver, or latch its wake behind maintenance or an aborted
     * activity. A wake sent while idle always opens its turn boundary, even
     * when its message was cleared; only a latched replay is suppressed when
     * the queue no longer holds the wake.
     * @param wakeAfterAbort - the {@link send} classification, captured before
     *   the inbox insertion so a reentrant cancel cannot reclassify it.
     */
    wakeDriver(wakeAfterAbort = false) {
        if (this.phase.kind !== 'idle') {
            // Maintenance and aborted drivers cannot deliver the wake: latch it for
            // replay at convergence. Live drivers claim queued work themselves;
            // disposal never latches, so teardown waits on no model turn.
            const reason = this.phase.abort.signal.reason;
            if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
                this.phase.wakeRequested = true;
            }
            return;
        }
        const driver = Promise.withResolvers();
        this.activityDone = driver.promise;
        this.setPhase({
            kind: 'running',
            abort: new AbortController(),
            turn: this.phase.lastTurn,
            step: 0,
            wakeRequested: false,
        });
        this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
    }
    async whenIdle() {
        let activity;
        do {
            await (activity = this.activityDone);
        } while (activity !== this.activityDone);
    }
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    throwError(error) {
        const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn;
        const step = this.phase.kind === 'running' ? this.phase.step : 0;
        this.dispatch.emit('agent/error', { turn, step, error });
        throw error;
    }
    async kick() {
        try {
            while (await this.turn()) { }
        }
        catch (_error) {
            // Reported failures and cancellation are contained at the driver boundary.
        }
        finally {
            /* v8 ignore next -- kick owns a running phase until this driver boundary */
            if (this.phase.kind === 'running') {
                const { turn, wakeRequested } = this.phase;
                this.setPhase({ kind: 'idle', lastTurn: turn });
                if (wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
            }
        }
    }
    async preStep(target, position) {
        /* v8 ignore next -- private callers establish the running phase before proposing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": pre-step outside running phase`);
        const signal = this.phase.abort.signal;
        const claimed = this.inbox.claim(target, position.turn);
        const assemblyRevision = this.requestConfigurationRevision;
        const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
        signal.throwIfAborted();
        const sections = renderContextSections(assembly);
        const context = this.runtimeContext.project(joinContextSections(sections), sections);
        const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal }, () => Promise.resolve({
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
        }));
        signal.throwIfAborted();
        if (decision.kind === 'reject')
            return decision;
        return { ...decision, assembly, assemblyRevision };
    }
    /** Whether the assembled tool schemas differ from the logged request header's. */
    toolsChanged(tools) {
        const baseline = this.session.requestHeader();
        if (baseline === undefined)
            return false;
        return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }));
    }
    /** Open one turn before claiming its first proposed step. */
    async turn() {
        if (this.phase.kind !== 'running') {
            this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
        }
        const phase = this.phase;
        const { signal } = phase.abort;
        signal.throwIfAborted();
        const turn = phase.turn + 1;
        try {
            this.session.append('turn/start', { turn });
        }
        catch (error) {
            this.throwError(error);
        }
        phase.turn = turn;
        let turnEnds = null;
        let concludedAtBoundary = false;
        let target = 'next-turn';
        try {
            while (true) {
                signal.throwIfAborted();
                const step = phase.step + 1;
                const boundary = await this.dispatch.waterfall('agent/step-boundary', { turn, step, signal }, () => Promise.resolve({ kind: 'continue' }));
                signal.throwIfAborted();
                if (boundary.kind === 'conclude') {
                    concludedAtBoundary = true;
                    turnEnds ??= { kind: 'completed' };
                    break;
                }
                const decision = await this.preStep(target, { turn, step });
                if (decision.kind === 'reject') {
                    turnEnds = { kind: 'blocked' };
                    return false;
                }
                if (turnEnds && decision.messages.length === 0)
                    break;
                // A removed waking message or an enter decision rewritten to empty
                // still owns the initial turn boundary, but it spends no model call.
                if (phase.step === 0 && decision.messages.length === 0) {
                    turnEnds = { kind: 'completed' };
                    return false;
                }
                signal.throwIfAborted();
                this.session.append('step/start', { turn, step });
                phase.step = step;
                try {
                    // max-tokens is sticky: once any step hits the ceiling, later steps
                    // that complete normally must not downgrade the turn outcome.
                    const stepEnd = await this.step(decision);
                    // max-tokens stays sticky: a later completed step must not
                    // downgrade the turn outcome.
                    if (turnEnds === null || turnEnds.kind !== 'max-tokens')
                        turnEnds = stepEnd;
                }
                finally {
                    this.session.append('step/end', { turn, step });
                }
                signal.throwIfAborted();
                if (turnEnds && this.inbox.nextStep.length === 0) {
                    await this.dispatch.serial('agent/turn-stopping', { turn, signal });
                    signal.throwIfAborted();
                }
                if (turnEnds && this.inbox.nextStep.length === 0)
                    break;
                target = 'next-step';
            }
        }
        catch (error) {
            if (signal.aborted) {
                turnEnds = { kind: 'aborted', reason: durableCancelCause(signal.reason) };
                throw error;
            }
            // Every failure is structured: an `LlmError` keeps its facts, anything
            // else flattens to `errorChain` text under the `UNKNOWN` code.
            turnEnds = {
                kind: 'error',
                error: error instanceof LlmError
                    ? error.failure
                    : { message: errorChain(error), code: 'UNKNOWN' },
            };
            this.throwError(error);
        }
        finally {
            let completionFailure;
            if (turnEnds?.kind === 'completed') {
                try {
                    // Covers every normal return, including initial-empty input and a
                    // boundary policy which concludes before entering the first step.
                    await this.loopCtx.parallel(agentCarrier(this), 'agent/turn-completing', { agent: this, turn, signal });
                    signal.throwIfAborted();
                }
                catch (error) {
                    completionFailure = error;
                    turnEnds = signal.aborted
                        ? { kind: 'aborted', reason: durableCancelCause(signal.reason) }
                        : { kind: 'error', error: error instanceof LlmError ? error.failure : { message: errorChain(error), code: 'UNKNOWN' } };
                }
            }
            try {
                // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
                this.session.append('turn/end', { turn, reason: turnEnds });
            }
            catch (error) {
                this.throwError(error);
            }
            if (completionFailure !== undefined)
                this.throwError(completionFailure);
        }
        if (!this.inbox.hasPending || (concludedAtBoundary && this.inbox.nextTurn.length === 0))
            return false;
        phase.abort = new AbortController();
        // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
        phase.wakeRequested = false;
        phase.step = 0;
        return true;
    }
    async step(decision) {
        /* v8 ignore next -- private callers establish the running phase before executing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": step outside running phase`);
        const { turn, step, abort: { signal } } = this.phase;
        signal.throwIfAborted();
        let { assembly } = decision;
        let assemblyRevision = decision.assemblyRevision;
        let renderedPrompt = renderPrompt(assembly);
        let firstAttempt = true;
        let pendingMessages = [...decision.messages];
        let recoveredBuildBudget = false;
        let planningRebuilds = 0;
        const rebuildAssembly = async () => {
            if (++planningRebuilds > 8)
                throw new LlmError('Request configuration did not stabilize before dispatch.', 'REQUEST_PLAN_UNSTABLE');
            // Capture before every await. Taking a token only at the end could bless
            // values made stale while an adapter or head provider was resolving.
            assemblyRevision = this.requestConfigurationRevision;
            assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
            const sections = renderContextSections(assembly);
            const context = this.runtimeContext.project(joinContextSections(sections), sections);
            if (firstAttempt) {
                pendingMessages = pendingMessages.filter(message => !isRuntimeContextMessage(message));
                if (context !== undefined)
                    pendingMessages.push(context);
            }
            else if (context !== undefined)
                this.session.append('user/message', context, { surfaceOp: 'append' });
            renderedPrompt = renderPrompt(assembly);
        };
        while (true) {
            if (assemblyRevision !== this.requestConfigurationRevision) {
                await rebuildAssembly();
                continue;
            }
            const { config, preparedCall } = await this.prepareRequest(turn, step, signal);
            if (assemblyRevision !== this.requestConfigurationRevision) {
                await rebuildAssembly();
                continue;
            }
            const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true;
            const commits = this.systemPrompt.project(renderedPrompt, {
                inHistory: preparedCall?.systemPromptUpdate === 'in-history',
                startsSeries: startsRequestSeries
                    || this.requestSurfaceGeneration !== this.session.surface.replaceGeneration
                    || this.toolsChanged(assembly.tools),
            });
            for (const { message, intent } of commits) {
                this.session.append('system/message', { turn, step, message }, intent);
            }
            if (firstAttempt) {
                for (const message of pendingMessages) {
                    this.session.append('user/message', message, { surfaceOp: 'append' });
                }
            }
            firstAttempt = false;
            let request;
            let planning;
            try {
                const headRevision = this.loopCtx.agentLoop.requestHeadRevisionFor(this.session.id);
                request = await this.buildRequest(config, preparedCall, assembly.tools, startsRequestSeries, signal);
                if (assemblyRevision !== this.requestConfigurationRevision
                    || headRevision !== this.loopCtx.agentLoop.requestHeadRevisionFor(this.session.id)) {
                    await rebuildAssembly();
                    continue;
                }
                planning = this.plannedRequest(request, turn, step, signal);
                await this.loopCtx.parallel(agentCarrier(this), 'agent/request-planning', planning);
                signal.throwIfAborted();
                if (!planning.revalidate()) {
                    // A coordinated replacement activates a new Persona prefix. Reuse
                    // neither the old assembly nor the old bound model request.
                    await rebuildAssembly();
                    continue;
                }
                assertRequestHeadBudget(this.session.requestContext()?.requestHead);
            }
            catch (error) {
                // Local complete-request budgeting must enter the same session-scoped
                // recovery path as a typed provider overflow. No provider request has
                // been made, and admitted messages must not be appended a second time.
                if (!(error instanceof LlmError) || error.code !== 'REQUEST_CONTEXT_BUDGET_EXCEEDED' || recoveredBuildBudget)
                    throw error;
                const action = await this.dispatch.waterfall('agent/request-error', {
                    turn, step, provider: config.provider,
                    failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: error.message },
                    retryPolicy: preparedCall?.retryPolicy, signal,
                }, () => Promise.resolve(undefined));
                signal.throwIfAborted();
                if (action?.kind !== 'retry')
                    throw error;
                recoveredBuildBudget = true;
                continue;
            }
            const requestId = randomUUID();
            // parallel waits for all listeners, including rejections. Unlike serial,
            // an incidental truthy return cannot suppress another durability gate.
            await this.loopCtx.parallel(agentCarrier(this), 'agent/request-ready', { agent: this, requestId, turn, step, request, signal });
            signal.throwIfAborted();
            // Receipt persistence is asynchronous too. A configuration or surface
            // edit during that final gate must not authorize the earlier snapshot.
            if (!planning.revalidate()) {
                await rebuildAssembly();
                continue;
            }
            const live = new AssistantStreamAttempt(this.session.id, ++this.assistantAttemptCounter, () => ++this.assistantStreamRevision, turn, step, (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }); });
            let started = false;
            try {
                const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);
                signal.throwIfAborted();
                live.start();
                started = true;
                for await (const chunk of stream) {
                    signal.throwIfAborted();
                    live.push(chunk);
                }
                signal.throwIfAborted();
            }
            catch (error) {
                if (!started)
                    throw error;
                try {
                    if (signal.aborted) {
                        const content = live.interruptedBlocks();
                        if (content.length > 0) {
                            live.settle('assistant/message', () => this.session.append('assistant/message', {
                                turn,
                                step,
                                message: createAssistantMessage({
                                    content,
                                    source: {
                                        provider: request.provider,
                                        model: request.model,
                                        ...live.replayState === undefined ? {} : { replayState: live.replayState },
                                    },
                                }),
                                interrupted: true,
                                ...live.usage === undefined ? {} : { usage: live.usage },
                                stream: live.stream,
                            }, { surfaceOp: 'append' }).seq);
                        }
                        else {
                            live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq);
                        }
                    }
                    else {
                        live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq);
                    }
                }
                catch (settlementError) {
                    throw new AggregateError([error, settlementError], 'Assistant stream failed and its durable settlement was rejected', { cause: error });
                }
                throw error;
            }
            try {
                const finish = live.finish;
                if (finish.kind === 'error' || finish.kind === 'aborted') {
                    live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq);
                    const action = await this.dispatch.waterfall('agent/request-error', {
                        turn,
                        step,
                        provider: request.provider,
                        failure: finish.failure,
                        retryPolicy: preparedCall?.retryPolicy,
                        signal,
                    }, () => Promise.resolve(undefined));
                    signal.throwIfAborted();
                    if (action?.kind !== 'retry') {
                        throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
                    }
                    continue;
                }
                const message = createAssistantMessage({
                    content: live.blocks(),
                    source: {
                        provider: request.provider,
                        model: request.model,
                        ...live.replayState !== undefined ? { replayState: live.replayState } : {},
                    },
                });
                let assistantSeq;
                live.settle('assistant/message', () => assistantSeq = this.session.append('assistant/message', {
                    turn,
                    step,
                    message,
                    ...live.usage === undefined ? {} : { usage: live.usage },
                    stream: live.stream,
                }, { surfaceOp: 'append' }).seq);
                await this.loopCtx.parallel(agentCarrier(this), 'agent/response-committed', { agent: this, requestId, turn, step, request, signal, assistantSeq, finish });
                signal.throwIfAborted();
                if (finish.kind === 'max-tokens')
                    return { kind: 'max-tokens' };
                const toolCalls = message.content.filter(block => block.type === 'tool-call');
                if (toolCalls.length === 0)
                    return { kind: 'completed' };
                const { concluded } = await executeToolCalls(this.loopCtx, turn, step, toolCalls, signal, context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]));
                return concluded ? { kind: 'completed' } : null;
            }
            catch (error) {
                if (!live.ended)
                    live.abandon();
                throw error;
            }
        }
    }
    /** A real immutable request plus a synchronous validity token, never a reassembled guess. */
    plannedRequest(request, turn, step, signal) {
        const fingerprint = () => JSON.stringify([
            this.session.surface.replaceGeneration,
            this.session.surface.nodes,
            this.session.requestHeader(),
            this.session.requestContext(),
            this.options,
            this.loopCtx.agentLoop.requestHeadRevisionFor(this.session.id),
            this.requestConfigurationRevision,
        ]);
        const revision = fingerprint();
        const header = this.session.requestHeader();
        if (!header)
            throw new Error('A planned request requires a committed request header.');
        return Object.freeze({
            agent: this, requestId: randomUUID(), turn, step, request, signal,
            requestHeader: deepFreeze(structuredClone(header)),
            requestContext: deepFreeze(structuredClone(this.session.requestContext())),
            surfaceSeqs: Object.freeze([...this.session.surface.nodes]),
            generation: this.session.surface.replaceGeneration,
            revalidate: () => !signal.aborted && fingerprint() === revision,
        });
    }
    /** Resolve request config and bind its adapter before admitting model-visible input. */
    async prepareRequest(turn, step, signal) {
        const { session } = this;
        // A loop instance starts from its declared route, restoring only an explicit
        // effort owned by that exact model. Later steps re-resolve marked defaults.
        const persistedHeader = session.requestHeader();
        const persistedConfig = persistedHeader?.config;
        const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' };
        const persistedReasoningEffort = persistedConfig?.provider === route.provider
            && persistedConfig.model === route.model
            && persistedHeader?.adapterDefaults?.reasoningEffort !== true
            ? persistedConfig.reasoningEffort
            : undefined;
        const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort;
        const maxTokens = this.options.maxTokens;
        const seedConfig = deepFreeze(structuredClone(this.requestHeaderLogged
            // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
            ? requestProposal(persistedHeader)
            : {
                ...route,
                ...reasoningEffort === undefined ? {} : { reasoningEffort },
                ...maxTokens === undefined ? {} : { maxTokens },
            }));
        const proposedConfig = await this.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seedConfig));
        signal.throwIfAborted();
        if (!proposedConfig.provider || !proposedConfig.model) {
            throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`);
        }
        let config;
        let preparedCall;
        try {
            preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal);
            config = preparedCall.config;
        }
        catch (error) {
            // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
            if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER')
                throw error;
            config = proposedConfig;
        }
        signal.throwIfAborted();
        return { config, ...preparedCall === undefined ? {} : { preparedCall } };
    }
    /** Log the resolved envelope and derive a frozen request from the admitted surface. */
    async buildRequest(config, preparedCall, tools, startsRequestSeries, signal) {
        const { session } = this;
        const surfaceGeneration = session.surface.replaceGeneration;
        const header = canonicalHeader({
            config,
            ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
            ...tools.length > 0 ? { tools } : {},
        });
        const baseline = this.session.requestHeader();
        const startsSeries = startsRequestSeries
            || this.requestSurfaceGeneration !== surfaceGeneration;
        if (!this.requestHeaderLogged) {
            this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' });
            this.requestHeaderLogged = true;
        }
        else if (baseline === undefined || !headerEquals(baseline, header)) {
            this.session.append('request/header', {
                header,
                reason: 'change',
                ...startsSeries ? { startsSeries: true } : {},
            });
        }
        else if (startsSeries) {
            this.session.append('request/header', { header, reason: 'series' });
        }
        this.requestSurfaceGeneration = surfaceGeneration;
        const contextWindow = preparedCall?.context?.contextWindow;
        const systemPromptUpdate = preparedCall?.systemPromptUpdate;
        const position = this.phase.kind === 'running' ? { turn: this.phase.turn, step: this.phase.step } : { turn: 0, step: 0 };
        const providedHead = await this.loopCtx.agentLoop.requestHeadFor({ agent: this, ...position, signal, config,
            ...preparedCall === undefined ? {} : { preparedCall } });
        const requestHead = providedHead === undefined ? undefined
            : priceRequestHead(session, providedHead, header, contextWindow, this.loopCtx.agentLoop.config.maxRequestHeadTokens);
        const requestContext = {
            provider: config.provider,
            model: config.model,
            ...contextWindow === undefined ? {} : { contextWindow },
            ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
            ...requestHead === undefined ? {} : { requestHead },
        };
        const previousContext = session.requestContext();
        if (previousContext?.provider !== requestContext.provider
            || previousContext.model !== requestContext.model
            || previousContext.contextWindow !== requestContext.contextWindow
            || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate
            || JSON.stringify(previousContext.requestHead) !== JSON.stringify(requestContext.requestHead)) {
            session.append('request/context', requestContext);
        }
        signal.throwIfAborted();
        // Use the immutable JSON snapshot that actually entered the native log.
        // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
        deepFreeze(header);
        const boundaryMessages = deriveRequestMessages(session);
        for (const message of boundaryMessages) {
            if (this.frozenMessages.has(message))
                continue;
            deepFreeze(message);
            this.frozenMessages.add(message);
        }
        Object.freeze(boundaryMessages);
        const request = markAgentLoopRequest(Object.freeze({
            ...header.config,
            messages: boundaryMessages,
            ...header.tools !== undefined ? { tools: header.tools } : {},
            sessionId: this.session.id,
            signal,
        }));
        return request;
    }
}
