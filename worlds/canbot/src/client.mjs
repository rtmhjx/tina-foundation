const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class ApiError extends Error {
  constructor(status, body) {
    super(`CANBOT API HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class CanbotClient {
  constructor({ baseUrl, timeoutMs, token = () => '' }) {
    this.baseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)
      || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error('CANBOT API 地址须为不含凭证、查询参数或片段的 HTTP(S) URL。');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30000) {
      throw new Error('requestTimeoutMs 必须是 250 到 30000 的整数。');
    }
    this.timeoutMs = timeoutMs;
    this.token = token;
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const token = this.token();
    if (!LOOPBACK.has(this.baseUrl.hostname) && !token) {
      throw new Error('远程 CANBOT API 缺少 CORTICO_CANBOT_API_TOKEN。');
    }
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(new URL(path, this.baseUrl), {
      method, headers, redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`CANBOT API HTTP ${response.status} 返回了非 JSON 响应。`); }
    if (!response.ok) throw new ApiError(response.status, data);
    if (path === '/v1/status' && data?.schemaVersion !== 1) {
      throw new Error('CANBOT API 状态响应不符合 schemaVersion=1。');
    }
    return data;
  }
}
