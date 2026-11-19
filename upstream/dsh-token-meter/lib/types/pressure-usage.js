import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';

// Cortico's ordinary usage is a billing total over attempts. Only the last
// request is a valid context-size anchor; missing last-request data is unknown.
export function pressureUsageOf(event, billingUsage) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const finish = Array.isArray(event.data.stream) ? lastAssistantStreamChunk(event.data.stream, 'finish') : undefined;
  const response = event.data.message?.source?.replayState?.response ?? finish?.replayState?.response;
  if (response?.kind === 'cortico-response-v1' || response?.kind === 'cortico-attempts-v1') {
    const last = response.lastRequestUsage;
    if (!['last-provider-attempt', 'response-usage'].includes(last?.basis)
      || !Number.isSafeInteger(last?.input) || last.input < 0) return undefined;
    return { inputTokens: last.input,
      ...(Number.isSafeInteger(last.output) && last.output >= 0 ? { outputTokens: last.output } : {}) };
  }
  // An interrupted attempt with no replay metadata has no reliable pressure sample.
  if (!finish && (event.type === 'assistant/attempt' || event.data.interrupted === true)) return undefined;
  return billingUsage;
}
