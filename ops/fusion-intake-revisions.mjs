import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Preserve changed native bytes as an additional Foundation revision, never an overwrite. */
export function revisionAwareIntake(sink, { foundationInput, foundationCanonical, readSource, onRevision = async () => {} }) {
  const same = (left, right) => foundationCanonical(left) === foundationCanonical(right);
  return {
    async ingestConversation(batch) {
      try { return await sink.ingestConversation(batch); }
      catch (error) { if (error.code !== 'EVENT_CONFLICT') throw error; }
      const receipt = { sourceIds: [], added: 0, jobIds: [] };
      for (const message of batch.messages) {
        let result;
        try { result = await sink.ingestConversation({ ...batch, messages: [message] }); }
        catch (error) {
          if (error.code !== 'EVENT_CONFLICT') throw error;
          const original = foundationInput(batch, message);
          const previous = await readSource(original.eventId);
          if (previous.id !== original.eventId || !same(previous.source, original.input.source)) {
            throw Object.assign(new Error('Native conflict origin differs; no revision written'), { code: 'NATIVE_CONFLICT_ORIGIN_MISMATCH' });
          }
          for (let revision = (message.revision ?? 1) + 1; ; revision++) {
            if (!Number.isSafeInteger(revision)) throw new Error('Native source revision overflow');
            const revised = { ...message, revision };
            const candidate = foundationInput(batch, revised);
            let existing;
            try { existing = await readSource(candidate.eventId); }
            catch (error) { if (error.status !== 404) throw error; }
            if (existing && !same(existing.source, candidate.input.source)) {
              throw Object.assign(new Error('Native revision origin differs'), { code: 'NATIVE_CONFLICT_ORIGIN_MISMATCH' });
            }
            const contentHash = createHash('sha256').update(foundationCanonical(candidate.input.payload)).digest('hex');
            if (existing && existing.contentHash !== contentHash) continue;
            try { result = await sink.ingestConversation({ ...batch, messages: [revised] }); }
            catch (error) { if (error.code === 'EVENT_CONFLICT') continue; throw error; }
            if (result.added) await onRevision({ at: new Date().toISOString(), priorEventId: original.eventId,
              revisedEventId: candidate.eventId, revision, sourceIdentitySha256: digest(candidate.input.source),
              reason: 'native-record-rewritten-under-existing-identity', originalBytesRetained: true, newBytesRetained: true });
            break;
          }
        }
        receipt.sourceIds.push(...result.sourceIds);
        receipt.added += result.added ?? 0;
        receipt.jobIds.push(...result.jobIds ?? []);
      }
      return receipt;
    },
  };
}
