import type { ISessionManager, ISessionScopeHandle } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_IDLE_RECLAIM_MS,
  SESSION_IDLE_RECLAIM_ENV,
  SessionIdleReaper,
  resolveSessionIdleReclaimMs,
} from '../src/services/sessionIdleReaper';
import type { ServerLogger } from '../src/services/pinoLoggerService';

function fakeSessions(ids: readonly string[]) {
  const calls: string[] = [];
  const fake: {
    calls: string[];
    impl: (sessionId: string) => Promise<boolean>;
    manager: Pick<ISessionManager, 'list' | 'closeIfIdle'>;
  } = {
    calls,
    impl: async (_sessionId: string) => true,
    manager: {
      list: () => ids.map((id) => ({ id }) as unknown as ISessionScopeHandle),
      closeIfIdle: async (sessionId: string) => {
        calls.push(sessionId);
        return fake.impl(sessionId);
      },
    } satisfies Pick<ISessionManager, 'list' | 'closeIfIdle'>,
  };
  return fake;
}

function fakeLogger(): Pick<ServerLogger, 'info' | 'warn'> {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Pick<ServerLogger, 'info' | 'warn'>;
}

describe('SessionIdleReaper', () => {
  it('resolves the idle timeout from the environment and schedules nothing when disabled', async () => {
    expect(resolveSessionIdleReclaimMs({})).toBe(DEFAULT_SESSION_IDLE_RECLAIM_MS);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: '5000' })).toBe(5000);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: '0' })).toBe(0);

    vi.useFakeTimers();
    try {
      const { manager, calls } = fakeSessions(['s1']);
      const logger = fakeLogger();
      new SessionIdleReaper(manager, logger, 0).start();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws for negative, non-integer, or non-numeric values', () => {
    for (const raw of ['-1', '0.5', 'nope']) {
      expect(() => resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: raw })).toThrow(
        /KIMI_CODE_SESSION_IDLE_RECLAIM_MS.*non-negative integer/,
      );
    }
  });

  it('sweeps live sessions on the interval, logs failures, and stops after close', async () => {
    vi.useFakeTimers();
    try {
      const sessions = fakeSessions(['s1', 's2']);
      const logger = fakeLogger();
      const reaper = new SessionIdleReaper(sessions.manager, logger, 30 * 60_000);
      reaper.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessions.calls).toEqual(['s1', 's2']);
      sessions.impl = async (sessionId) => {
        if (sessionId === 's1') throw new Error('boom');
        return true;
      };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessions.calls).toHaveLength(4);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1' }),
        'session idle reclaim failed',
      );
      await reaper.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-enter a running sweep, and close waits for it', async () => {
    vi.useFakeTimers();
    try {
      const sessions = fakeSessions(['s1']);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sessions.impl = async () => {
        await gate;
        return true;
      };
      const reaper = new SessionIdleReaper(sessions.manager, fakeLogger(), 1000);
      const first = reaper.sweep();
      expect(reaper.sweep()).toBe(first);
      reaper.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.calls).toEqual(['s1']);
      let closed = false;
      const closing = reaper.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.calls).toEqual(['s1']);
      expect(closed).toBe(false);
      release();
      await Promise.all([first, closing]);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
