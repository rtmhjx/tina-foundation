import { isAbsolute, resolve } from 'node:path';

/** Verified against @deepseek-ai/dsh-tool-fs@0.1.5-rc.2 (read.file_path)
 * and dsh-tool-str-replace-editor (command=view, path). Shell output or a
 * write receipt is deliberately insufficient, even when it contains the code.
 */
export function nativeFileReadEvidence(events, expectedFile, required, { cwd } = {}) {
  if (!isAbsolute(expectedFile) || !Array.isArray(required) || !required.length
      || required.some(value => typeof value !== 'string' || !value)) return false;
  const normalized = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const target = normalized(expectedFile);
  function readCall(data) {
    let args = data?.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return false; } }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const path = data.name === 'read' ? args.file_path
      : data.name === 'str_replace_editor' && args.command === 'view' ? args.path : undefined;
    if (typeof path !== 'string' || !path || path.includes('\0')) return false;
    if (!isAbsolute(path) && (typeof cwd !== 'string' || !isAbsolute(cwd))) return false;
    return normalized(isAbsolute(path) ? path : resolve(cwd, path)) === target;
  }
  function contains(content) {
    const text = (Array.isArray(content) ? content : []).filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n');
    return required.every(value => text.includes(value));
  }
  const calls = new Map();
  for (const event of events) {
    if (event.type === 'tool/call' && readCall(event.data)) calls.set(event.data.callId, event.seq);
    if (event.type === 'tool/ptc-dispatch' && readCall(event.data) && !event.data.isError && contains(event.data.content)) return true;
    if (event.type !== 'tool/result') continue;
    for (const block of event.data.message?.content ?? []) {
      if (block.type === 'tool-result' && !block.isError && calls.has(block.toolCallId)
          && calls.get(block.toolCallId) < event.seq && contains(block.content)) return true;
    }
  }
  return false;
}
