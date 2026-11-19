/** Public stage-budget policy. Invalid values fail before acquiring a runtime. */
export function normalizeContextPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new TypeError('contextPolicy must be an object.'), { code: 'CONTEXT_POLICY_INVALID' });
  }
  for (const key of Object.keys(value)) {
    if (!['stageBudgetTokens', 'thresholdRatio'].includes(key)) {
      throw Object.assign(new TypeError('Unknown contextPolicy field: ' + key), { code: 'CONTEXT_POLICY_INVALID' });
    }
  }
  const stageBudgetTokens = value.stageBudgetTokens === undefined ? 64000 : value.stageBudgetTokens;
  const thresholdRatio = value.thresholdRatio === undefined ? 0.85 : value.thresholdRatio;
  if (!Number.isSafeInteger(stageBudgetTokens) || stageBudgetTokens <= 0
      || typeof thresholdRatio !== 'number' || !Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio >= 1) {
    throw Object.assign(new RangeError('contextPolicy requires a positive integer stageBudgetTokens and 0 < thresholdRatio < 1.'), { code: 'CONTEXT_POLICY_INVALID' });
  }
  return Object.freeze({ stageBudgetTokens, thresholdRatio });
}

/** Inspect the selected session scope; a replacement implementation may satisfy the protocol. */
export function missingContextCapabilities(ctx, agent, scopedEngine) {
  const lookup = name => scopedEngine?.ctx?.get?.(name) ?? agent?.ctx?.get?.(name) ?? ctx.get?.(name);
  const missing = [];
  if (typeof (scopedEngine ?? lookup('compaction'))?.inspectFusionPressure !== 'function') missing.push('compaction.inspectFusionPressure');
  if (typeof lookup('tokenMeter')?.measure !== 'function') missing.push('tokenMeter.measure');
  if (lookup('tokenMeter')?.requestHeadAccountingVersion !== 1) missing.push('tokenMeter.requestHeadAccountingVersion=1');
  if (typeof agent?.prepareMaintenanceRequest !== 'function') missing.push('agent.prepareMaintenanceRequest');
  return missing;
}
