import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export { getSessionId } from '../session-identity.mjs';
import { getSessionId } from '../session-identity.mjs';

async function readText(request) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('Expected JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof text !== 'string' || !text.trim() || text.length > 16_000) throw new Error('Invalid text');
  return text;
}

function sendJson(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** Private local input adapter. DSH owns admission, execution, history and the returned turn. */
export async function openChatRuntime({ stateDir, sendText }) {
  const sessionId = await getSessionId(stateDir);
  const token = randomBytes(32).toString('base64url');
  const credential = Buffer.from('Bearer ' + token);
  const shutdown = new AbortController();
  let queue = Promise.resolve();
  let closed;

  const server = createServer(async (request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== credential.length || !timingSafeEqual(credential, authorization)) {
      request.resume();
      return sendJson(response, 401, { error: 'DSH 本地入口鉴权失败。' });
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat') {
      request.resume();
      return sendJson(response, 404, { error: 'DSH 本地入口不存在。' });
    }
    const connection = new AbortController();
    response.once('close', () => connection.abort());
    const signal = AbortSignal.any([shutdown.signal, connection.signal]);
    let text;
    try {
      text = await readText(request);
    } catch {
      return sendJson(response, 400, { error: 'DSH 本地入口仅接受有效的文字请求。' });
    }

    const turn = queue.then(() => {
      signal.throwIfAborted();
      return sendText({ sessionId, requestId: randomUUID(), text, signal });
    });
    queue = turn.then(() => {}, () => {});
    try {
      const result = await turn;
      if (!result?.text?.trim()) {
        return sendJson(response, 502, { error: 'DSH 结束了这一轮，但没有可显示的正文。请查看 DSH 会话。' });
      }
      sendJson(response, 200, { text: result.text });
    } catch {
      sendJson(response, 502, { error: 'DSH 尚未完成回复。请打开「DSH 模型和工具」检查模型或待确认操作。' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    url: 'http://127.0.0.1:' + server.address().port,
    token,
    close() {
      if (closed) return closed;
      shutdown.abort();
      closed = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      }).then(() => queue);
      return closed;
    },
  };
}
