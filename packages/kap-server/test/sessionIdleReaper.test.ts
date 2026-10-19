import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Event2,
  type ISessionScopeHandle,
  IAgentLifecycleService,
  IEventBus,
  ISessionManager,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  DEFAULT_SESSION_IDLE_RECLAIM_MS,
  SESSION_IDLE_RECLAIM_ENV,
  SessionIdleReaper,
  resolveSessionIdleReclaimMs,
} from '../src/services/sessionIdleReaper';
import type { ServerLogger } from '../src/services/pinoLoggerService';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders, authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface FakeSessions {
  readonly manager: Pick<ISessionManager, 'list' | 'closeIfIdle'>;
  readonly calls: string[];
  gate: Promise<void>;
}

function fakeSessions(ids: readonly string[]): FakeSessions {
  const calls: string[] = [];
  const fake: FakeSessions = {
    calls,
    gate: Promise.resolve(),
    manager: {
      list: () => ids.map((id) => ({ id }) as unknown as ISessionScopeHandle),
      closeIfIdle: async (sessionId: string) => {
        calls.push(sessionId);
        await fake.gate;
        return true;
      },
    },
  };
  return fake;
}

function fakeLogger(): Pick<ServerLogger, 'info' | 'warn'> & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Pick<ServerLogger, 'info' | 'warn'> & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('resolveSessionIdleReclaimMs', () => {
  it('uses the default, honors overrides, and ignores invalid values', () => {
    expect(resolveSessionIdleReclaimMs({})).toBe(DEFAULT_SESSION_IDLE_RECLAIM_MS);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: '5000' })).toBe(5000);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: '0' })).toBe(0);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: 'nope' })).toBe(
      DEFAULT_SESSION_IDLE_RECLAIM_MS,
    );
  });
});

describe('SessionIdleReaper', () => {
  it('does not schedule sweeps when the idle timeout is disabled', async () => {
    vi.useFakeTimers();
    const { manager, calls } = fakeSessions(['s1']);
    const logger = fakeLogger();
    const reaper = new SessionIdleReaper(manager, logger, 0);
    reaper.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
    await reaper.close();
    vi.useRealTimers();
  });

  it('sweeps live sessions on the interval and stops after close', async () => {
    vi.useFakeTimers();
    const { manager, calls } = fakeSessions(['s1', 's2']);
    const logger = fakeLogger();
    const reaper = new SessionIdleReaper(manager, logger, 30 * 60_000);
    reaper.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['s1', 's2']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(4);
    await reaper.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(4);
    vi.useRealTimers();
  });

  it('does not start a second sweep while one is in flight', async () => {
    const sessions = fakeSessions(['s1']);
    let release!: () => void;
    sessions.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reaper = new SessionIdleReaper(sessions.manager, fakeLogger(), 1000);
    const first = reaper.sweep();
    const second = reaper.sweep();
    expect(second).toBe(first);
    release();
    await first;
    expect(sessions.calls).toEqual(['s1']);
  });

  it('close waits for an in-flight sweep and prevents further sweeps', async () => {
    vi.useFakeTimers();
    const sessions = fakeSessions(['s1']);
    let release!: () => void;
    sessions.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reaper = new SessionIdleReaper(sessions.manager, fakeLogger(), 1000);
    reaper.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessions.calls).toEqual(['s1']);
    let closed = false;
    const closing = reaper.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessions.calls).toEqual(['s1']);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    vi.useRealTimers();
  });

  it('logs a failed reclaim and continues with the remaining sessions', async () => {
    const calls: string[] = [];
    const manager = {
      list: () => [{ id: 's1' }, { id: 's2' }] as unknown as ISessionScopeHandle[],
      closeIfIdle: async (sessionId: string) => {
        calls.push(sessionId);
        if (sessionId === 's1') throw new Error('boom');
        return true;
      },
    };
    const logger = fakeLogger();
    const reaper = new SessionIdleReaper(manager, logger, 1000);
    await reaper.sweep();
    expect(calls).toEqual(['s1', 's2']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' }),
      'session idle reclaim failed',
    );
  });
});

interface Frame {
  type: string;
  id?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

interface Conn {
  ws: WebSocket;
  closed: Promise<void>;
  send: (f: unknown) => void;
  next: (pred: (f: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
}

function openConn(url: string, token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const frames: Frame[] = [];
    const waiters: Array<(f: Frame) => void> = [];
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    ws.on('message', (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse((data as Buffer).toString()) as Frame;
      } catch {
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else frames.push(frame);
    });
    ws.once('open', () =>
      resolve({
        ws,
        closed,
        send: (f) => ws.send(JSON.stringify(f)),
        next: (pred, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const queued = frames.findIndex(pred);
            if (queued >= 0) {
              res(frames.splice(queued, 1)[0]!);
              return;
            }
            const deadline = Date.now() + timeoutMs;
            let timer: ReturnType<typeof setTimeout>;
            const waiter = (frame: Frame): void => {
              clearTimeout(timer);
              if (pred(frame)) {
                res(frame);
                return;
              }
              frames.push(frame);
              waiters.push(waiter);
              arm();
            };
            const arm = (): void => {
              const left = deadline - Date.now();
              if (left <= 0) {
                rej(new Error('timeout waiting for frame'));
                return;
              }
              timer = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                rej(new Error(`timeout waiting for frame; seen: ${frames.map((f) => f.type).join(',')}`));
              }, left);
            };
            arm();
            waiters.push(waiter);
          }),
      }),
    );
    ws.once('error', reject);
  });
}

describe('session idle reclaim over REST and WS', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-idle-reaper-e2e-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('reclaims an idle session and transparently resumes it on the next access', async () => {
    const created = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    }).then(async (res) => (await res.json()) as { code: number; data: { id: string } });
    expect(created.code).toBe(0);
    const sid = created.data.id;

    const manager = server!.core.accessor.get(ISessionManager);
    expect(await manager.closeIfIdle(sid, 60_000)).toBe(false);
    expect(manager.get(sid)).toBeDefined();

    const session = getLiveSessionById(server!.core.accessor, sid);
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.handleOf('main') === undefined) await agents.create({ agentId: 'main' });

    const token = server!.authTokenService.getToken();
    const c = await openConn(wsUrl, token);
    await c.next((f) => f.type === 'server_hello');
    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: { token, client_id: 'cli', subscriptions: [sid] },
    });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');
    c.send({
      type: 'subscribe_v2',
      id: 'sub-1',
      payload: { session_id: sid, transcript: { '*': 'delta' } },
    });
    await c.next((f) => f.type === 'transcript.reset');

    expect(await manager.closeIfIdle(sid, 0)).toBe(true);
    expect(manager.get(sid)).toBeUndefined();

    const detail = await authedFetch(server as RunningServer, base, `/api/v1/sessions/${sid}`);
    expect(detail.status).toBe(200);
    expect(manager.get(sid)).toBeUndefined();

    const warnings = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/sessions/${sid}/warnings`,
    );
    expect(warnings.status).toBe(200);
    expect(manager.get(sid)).toBeDefined();

    await c.next((f) => f.type === 'transcript.reset' || f.type === 'transcript.ops');
    c.send({
      type: 'subscribe_v2',
      id: 'sub-2',
      payload: { session_id: sid, transcript: { '*': 'delta' } },
    });
    const ack2 = await c.next((f) => f.type === 'ack' && f.id === 'sub-2');
    expect(ack2.payload).toMatchObject({ accepted: [sid], not_found: [] });

    const resumed = getLiveSessionById(server!.core.accessor, sid);
    const main = resumed!.accessor.get(IAgentLifecycleService).handleOf('main');
    main!.accessor
      .get(IEventBus)
      .publish({ type: 'turn.started', turnId: 7, agentId: 'main', origin: { kind: 'user' } } as unknown as Event2<any>);
    const frame = await c.next(
      (f) => f.type === 'event.session.work_changed' && f.payload?.['busy'] === true,
    );
    expect(frame.session_id).toBe(sid);

    c.ws.close();
    await c.closed;
  }, 30_000);
});
