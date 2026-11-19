import { estimateMessagesTokens } from '../upstream/cortico/src/core/util.ts';

/** A volatile view of native session events for Cortico's existing observers. */
export function createNativeSessionProjection(SessionLog, { dataDir, sourceSessionId }) {
  return new class extends SessionLog {
    get sourceSessionId() { return sourceSessionId; }
    #records = [];
    #append = new Set();
    #reset = new Set();
    get records() { return this.#records; }
    onAppend(callback) { this.#append.add(callback); }
    onReset(callback) { this.#reset.add(callback); }
    load() { return null; }
    append(record) {
      this.#records.push(record);
      for (const callback of this.#append) callback(record, this.#records.length - 1);
    }
    reset(records) {
      this.#records = [...records];
      for (const callback of this.#reset) callback([...this.#records]);
    }
    estTokens() { return estimateMessagesTokens(this.#records); }
  }(dataDir, 'native-session-projection');
}
