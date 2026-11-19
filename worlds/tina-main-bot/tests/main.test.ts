import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import definition from '../index.ts';
import type { BotStartContext } from 'cortico/bot.ts';
import type { BotConfig } from 'cortico/../bots/corti-soulmate/index.ts';
import type { CortiSoulmate } from 'cortico/../bots/corti-soulmate/persona/index.ts';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('event-driven main deployment', () => {
  it('initializes a real recovery checkpoint while scheduling no baseline wakeups', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'tina-main-bot-'));
    directories.push(root);
    const config = definition.defaults();
    const parts = definition.build({
      config,
      secret: () => '',
      rootDir: root,
      memoryDir: join(root, 'workspace'),
      dataDir: join(root, 'data'),
    }, []);
    await parts.onStart?.({
      core: { runlog: { logger: () => ({ info() {}, warn() {} }) } },
    } as unknown as BotStartContext<BotConfig>);
    const persona = parts.persona as CortiSoulmate;
    expect(persona.git.status().repo).toBe(true);
    expect(persona.git.listTags().some((tag) => tag.name === 'checkpoint0')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    await parts.onStop?.();
  });

  it('retains the official main and consolidation sessions without declaring QQ', () => {
    const root = mkdtempSync(join(tmpdir(), 'tina-main-sessions-'));
    directories.push(root);
    const parts = definition.build({
      config: definition.defaults(), secret: () => '', rootDir: root,
      memoryDir: join(root, 'workspace'), dataDir: join(root, 'data'),
    }, []);
    const sessions = parts.persona.declareSessions();
    expect(sessions.filter((session) => session.receivesEvents)).toHaveLength(1);
    expect(sessions.some((session) => session.id === 'dream')).toBe(true);
    expect(definition.declares).toEqual(['console', 'mobile', 'tinalink', 'websearch']);
    expect(definition.describe?.memory).toBeDefined();
  });
});
