/**
 * @vitest-environment jsdom
 * main.ts 的两处壳逻辑:面板 memo 的读写优先级,以及 boot 在能力清单到达前被 dispose。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const MAIN = '../../src/web/client/main.ts';
const MEMO = '../../src/web/client/core/memo.ts';

type Any = any;

const flush = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
  window.location.hash = '';
});

describe('createMemo', () => {
  it('localStorage 写不进去时读回本会话写的值,不是落盘的旧值', async () => {
    const { createMemo } = (await import(MEMO)) as Any;
    localStorage.setItem('cortico.test.k', JSON.stringify('old'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const memo = createMemo('cortico.test.');
    memo.set('k', 'new');
    expect(memo.get('k', 'dflt')).toBe('new');
  });

  it('没写过就读 localStorage;没有记录或记录坏了都退回缺省', async () => {
    const { createMemo } = (await import(MEMO)) as Any;
    localStorage.setItem('cortico.test.k', JSON.stringify({ n: 1 }));
    localStorage.setItem('cortico.test.bad', '{not json');
    const memo = createMemo('cortico.test.');
    expect(memo.get('k', null)).toEqual({ n: 1 });
    expect(memo.get('bad', 'dflt')).toBe('dflt');
    expect(memo.get('missing', 'dflt')).toBe('dflt');
  });
});

describe('boot', () => {
  it('全局状态通道在非 Live 路由仍更新外壳，dispose 关闭连接并摘除监听', async () => {
    window.location.hash = '#/unclaimed';
    const sockets: Any[] = [];
    class StatusSocket {
      readyState = 1;
      onopen: Any = null; onclose: Any = null; onerror: Any = null; onmessage: Any = null;
      closed = false;
      constructor(readonly url: string) { sockets.push(this); }
      send(): void {}
      close(): void { this.closed = true; }
    }
    vi.stubGlobal('WebSocket', StatusSocket);
    vi.stubGlobal('fetch', (url: unknown) => {
      const path = String(url);
      if (path.includes('/api/capabilities')) return Promise.resolve(json({ capabilities: { debug: true, run: true } }));
      if (path.includes('/api/webui/manifest')) return Promise.resolve(json({ protocolVersion: 1, pages: [], framework: { capabilities: {} } }));
      if (path.includes('/api/status')) return Promise.resolve(json({ loop: { paused: true } }));
      return Promise.resolve(json({}));
    });
    const { boot } = (await import(MAIN)) as Any;
    const app = boot(document);
    await flush();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    expect(socket.url).toContain('/ws/status');
    expect(document.querySelector('.rail-runstate')!.textContent).toBe('已暂停');
    socket.onmessage({ data: JSON.stringify({ t: 'status', status: { loop: { paused: false } } }) });
    expect(document.querySelector('.rail-runstate')!.textContent).toBe('运行中');
    expect(document.querySelector('.rail-run')!.getAttribute('aria-label')).toBe('暂停运行');
    app.dispose();
    expect(socket.closed).toBe(true);
    expect(socket.onmessage).toBe(null);
  });

  it('能力清单到达前 dispose:到达后不再导航,不再渲染', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/capabilities')) {
        return gate.then(() => json({ capabilities: { debug: true, sessions: true } }));
      }
      if (u.includes('/api/webui/manifest')) {
        return gate.then(() => json({ protocolVersion: 1, providers: [], framework: { capabilities: {} } }));
      }
      return Promise.resolve(json({}));
    });
    const { boot } = (await import(MAIN)) as Any;
    const app = boot(document);
    await flush();
    app.dispose();
    release();
    await flush();
    // 没 dispose 的话空路由会被换成控制台页,hash 变成 #/live,并在已清空的根里挂页。
    expect(window.location.hash).toBe('');
    expect(document.getElementById('kernel-root')!.textContent).toBe('');
  });
});
