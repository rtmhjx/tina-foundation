export const name = 'fusion-autonomy-policy';
export const inject = ['fusionIntentions', 'systemPrompt'];

/** Report the current native step budget; choosing another wake belongs to the Persona. */
export function apply(ctx, { sessionId, roundPolicyFor }) {
  if (typeof sessionId !== 'string' || !sessionId || typeof roundPolicyFor !== 'function') {
    throw new Error('An autonomy policy requires a session and its frozen round policy.');
  }
  let budget;
  ctx.on('agent/step-boundary', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (agent.id !== sessionId) return decision;
    budget = undefined;
    if (decision.kind === 'conclude') return decision;
    signal.throwIfAborted();
    const { hard } = roundPolicyFor(turn);
    if (!Number.isSafeInteger(hard) || hard < 1 || !Number.isSafeInteger(step) || step < 1) {
      throw Object.assign(new Error('The current native step is outside its declared round policy.'), { code: 'AUTONOMY_BUDGET_INVALID' });
    }
    if (step > hard) return decision;
    const state = ctx.fusionIntentions.list();
    const activeGoals = state.goals.filter(goal => goal.status === 'active').map(goal => ({
      id: goal.id,
      wake: goal.wake ? {
        id: goal.wake.id, stage: goal.wake.stage, dueAt: goal.wake.dueAt,
        ...(Number.isSafeInteger(goal.wake.archiveCursor) ? { archiveCursor: goal.wake.archiveCursor } : {}),
      } : null,
      nextWakePending: goal.wake?.stage === 'scheduled' || goal.wake?.stage === 'pending',
    }));
    if (!activeGoals.length) return decision;
    budget = Object.freeze({ turn, step, hard, remainingSteps: hard - step + 1, includesCurrentStep: true,
      intentionsRevision: state.revision, activeGoals });
    return decision;
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (agent.id === sessionId && decision.kind !== 'enter') budget = undefined;
    return decision;
  });
  ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'turn/end') budget = undefined;
  });
  const remove = ctx.systemPrompt.context({
    name: 'fusion:intention-budget/' + sessionId,
    order: 7200,
    text: ({ agent }) => agent?.id === sessionId && budget ? JSON.stringify(budget) : '',
  });
  ctx.effect(() => () => { budget = undefined; if (typeof remove === 'function') remove(); });
}
