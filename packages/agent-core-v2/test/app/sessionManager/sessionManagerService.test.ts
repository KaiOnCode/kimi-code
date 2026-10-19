import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { reloadOnStale } from '#/app/sessionManager/sessionLookup';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import { ErrorCodes } from '#/errors';
import { IAgentCronService } from '#/features/cron/cronService';
import { IAgentGoalService } from '#/features/goal/goalService';
import { InMemorySessionLockService } from '#/persistence/backends/memory/sessionLockService';
import { sessionOccupiedError, type ISessionLockService } from '#/persistence/interface/sessionLock';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionTerminalService } from '#/session/terminal/terminalService';
import type {
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

function controller(sessionId = 'session-1'): {
  readonly service: SessionLifecycleService;
  readonly handle: ISessionScopeHandle;
} {
  const handle = { id: sessionId } as unknown as ISessionScopeHandle;
  const willCreate = new Emitter<SessionWillCreateEvent>();
  const didCreate = new Emitter<SessionCreatedEvent>();
  const didClose = new Emitter<SessionClosedEvent>();
  const service = {
    onWillCreateSession: willCreate.event,
    onDidCreateSession: didCreate.event,
    onWillCloseSession: Event.None,
    onDidCloseSession: didClose.event,
    onDidArchiveSession: Event.None,
    onDidForkSession: Event.None,
    create: async () => {
      didCreate.fire({ sessionId, handle, source: 'startup' });
      return handle;
    },
    get: (id: string) => id === sessionId ? handle : undefined,
    list: () => [handle],
    resume: async () => handle,
    close: async (sessionId: string) => { didClose.fire({ sessionId }); },
    archive: async () => {},
    restore: async () => handle,
    delete: async () => {},
    fork: async () => handle,
    createChild: async () => handle,
    dispose: () => {},
  } as unknown as SessionLifecycleService;
  return { service, handle };
}

async function drainMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('SessionManager', () => {
  it('serializes resume, close, and lifecycle critical sections per session', async () => {
    const didCreate = new Emitter<SessionCreatedEvent>();
    const didClose = new Emitter<SessionClosedEvent>();
    const handle = { id: 'session-1' } as unknown as ISessionScopeHandle;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const order: string[] = [];
    const service = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: didClose.event,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async () => handle,
      get: () => undefined,
      list: () => [],
      resume: async () => {
        order.push('resume:start');
        await resumeGate;
        didCreate.fire({ sessionId: 'session-1', handle, source: 'startup' });
        order.push('resume:end');
        return handle;
      },
      close: async () => {
        order.push('close');
        didClose.fire({ sessionId: 'session-1' });
      },
      archive: async () => {},
      restore: async () => handle,
      delete: async () => {},
      fork: async () => handle,
      createChild: async () => handle,
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    const resumePromise = manager.resume('session-1');
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section');
    });
    const closePromise = manager.close('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['resume:start']);
    releaseResume();
    await Promise.all([resumePromise, section, closePromise]);
    expect(order).toEqual(['resume:start', 'resume:end', 'section', 'close']);
    manager.dispose();
  });

  it('holds a resume started during a lifecycle critical section', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const order: string[] = [];
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const resumePromise = manager.resume('session-1').then((handle) => {
      order.push('resume');
      return handle;
    });
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, resumePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'resume']);
    manager.dispose();
  });

  it('serializes delete with the per-session lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { delete: () => Promise<void> }).delete = async () => {
      order.push('delete');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const deletePromise = manager.delete('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, deletePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'delete']);
    manager.dispose();
  });

  it('serializes fork of the source session with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { fork: () => Promise<unknown> }).fork = async () => {
      order.push('fork');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const forkPromise = manager.fork({ sourceSessionId: 'session-1' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, forkPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'fork']);
    manager.dispose();
  });

  it('serializes fork of an explicit target id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { fork: () => Promise<unknown> }).fork = async () => {
      order.push('fork');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-2', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const forkPromise = manager.fork({ sourceSessionId: 'session-1', newSessionId: 'session-2' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, forkPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'fork']);
    manager.dispose();
  });

  it('serializes createChild of an explicit target id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { createChild: () => Promise<unknown> }).createChild = async () => {
      order.push('createChild');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-2', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const childPromise = manager.createChild({ sourceSessionId: 'session-1', newSessionId: 'session-2' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, childPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'createChild']);
    manager.dispose();
  });

  it('serializes create with an explicit session id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { create: () => Promise<unknown> }).create = async () => {
      order.push('create');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const createPromise = manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, createPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'create']);
    manager.dispose();
  });

  it('serializes archive with the per-session lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { archive: () => Promise<void> }).archive = async () => {
      order.push('archive');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const archivePromise = manager.archive('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, archivePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'archive']);
    manager.dispose();
  });

  it('propagates a failed resume to the next settle until a fresh attempt supersedes', async () => {
    let fail = true;
    const fake = controller();
    (fake.service as unknown as { resume: () => Promise<unknown> }).resume = async () => {
      if (fail) throw new Error('boom');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());

    await expect(manager.resume('session-1')).rejects.toThrow('boom');
    await expect(manager.whenResumeSettled('session-1')).rejects.toThrow('boom');

    fail = false;
    await manager.resume('session-1');
    await expect(manager.whenResumeSettled('session-1')).resolves.toBeUndefined();
    manager.dispose();
  });

  it('owns one global live-session registry across workspace controllers', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    const index = { get: async () => undefined } as unknown as ISessionIndex;
    const manager = new SessionManager(workspaces, index, new InMemorySessionLockService());
    const created = await manager.create({ workDir: '/workspace' });
    expect(created).toBe(fake.handle);
    expect(manager.get('session-1')).toBe(fake.handle);
    expect(manager.list()).toEqual([fake.handle]);
    await manager.close('session-1');
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.list()).toEqual([]);
    manager.dispose();
  });

  it('uses the replacement Program generation for new sessions while retaining live owners', async () => {
    const first = controller('session-1');
    const second = controller('session-2');
    let generation = 'generation-1';
    const workspace = {
      id: 'workspace-1',
      program: {
        get sessionControllerGeneration() { return generation; },
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
      new InMemorySessionLockService(),
    );

    expect(await manager.create({ workDir: '/workspace' })).toBe(first.handle);
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(manager.list()).toEqual([first.handle, second.handle]);

    await manager.close('session-1');
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.get('session-2')).toBe(second.handle);
    manager.dispose();
  });

  it('retires a superseded controller that never came to own a session', async () => {
    const first = controller('session-1');
    const second = controller('session-2');
    (first.service as { create: unknown }).create = async () => {
      throw new Error('boom');
    };
    const disposeFirst = vi.fn();
    (first.service as { dispose: unknown }).dispose = disposeFirst;
    let generation = 'generation-1';
    const workspace = {
      id: 'workspace-1',
      program: {
        get sessionControllerGeneration() { return generation; },
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
      new InMemorySessionLockService(),
    );

    await expect(manager.create({ workDir: '/workspace' })).rejects.toThrow('boom');
    expect(disposeFirst).not.toHaveBeenCalled();
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(manager.get('session-2')).toBe(second.handle);
    manager.dispose();
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });
});

describe('SessionManager closeIfIdle', () => {
  interface ReclaimOverrides {
    readonly busy?: boolean;
    readonly pendingInteraction?: 'none' | 'approval' | 'question';
    readonly terminalStatus?: 'running' | 'exited';
    readonly cronTasks?: number;
    readonly goalStatus?: 'active' | 'paused' | 'blocked' | 'complete';
  }

  interface ReclaimFake {
    service: SessionLifecycleService;
    readonly handle: ISessionScopeHandle;
    readonly closed: string[];
    readonly disposed: string[];
    resumeCalls: number;
    resumeMode: 'live' | 'cold';
  }

  function reclaimController(sessionId: string, overrides: ReclaimOverrides = {}): ReclaimFake {
    const didCreate = new Emitter<SessionCreatedEvent>();
    const didClose = new Emitter<SessionClosedEvent>();
    const closed: string[] = [];
    const disposed: string[] = [];
    const state = {
      busy: overrides.busy ?? false,
      pendingInteraction: overrides.pendingInteraction ?? ('none' as const),
      terminalStatus: overrides.terminalStatus ?? ('exited' as const),
      cronTasks: overrides.cronTasks ?? 0,
      goalStatus: overrides.goalStatus,
    };
    const makeHandle = (): ISessionScopeHandle => {
      const agentHandle = {
        id: 'main',
        accessor: {
          get: (token: unknown) => {
            if (token === IAgentCronService) {
              return { list: () => Array.from({ length: state.cronTasks }) };
            }
            if (token === IAgentGoalService) {
              return {
                getGoal: () => ({
                  goal: state.goalStatus === undefined ? null : { status: state.goalStatus },
                }),
              };
            }
            return undefined;
          },
        },
      };
      const agents = {
        list: () => [{ agentId: 'main' }],
        handleOf: (agentId: string) => (agentId === 'main' ? agentHandle : undefined),
      };
      return {
        id: sessionId,
        accessor: {
          get: (token: unknown) => {
            if (token === ISessionActivityView) {
              return {
                state: () => ({
                  busy: state.busy,
                  mainTurnActive: false,
                  pendingInteraction: state.pendingInteraction,
                }),
              };
            }
            if (token === ISessionTerminalService) {
              return { list: async () => [{ status: state.terminalStatus }] };
            }
            if (token === IAgentLifecycleService) return agents;
            return undefined;
          },
        },
        dispose: () => {
          disposed.push(sessionId);
        },
      } as unknown as ISessionScopeHandle;
    };
    const handle = makeHandle();
    const fake: ReclaimFake = {
      service: undefined as unknown as SessionLifecycleService,
      handle,
      closed,
      disposed,
      resumeCalls: 0,
      resumeMode: 'live',
    };
    fake.service = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: didClose.event,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async () => {
        didCreate.fire({ sessionId, handle, source: 'startup' });
        return handle;
      },
      get: () => undefined,
      list: () => [],
      resume: async () => {
        fake.resumeCalls += 1;
        if (fake.resumeMode === 'cold') {
          const next = makeHandle();
          didCreate.fire({ sessionId, handle: next, source: 'resume' });
          return next;
        }
        return handle;
      },
      close: async (id: string) => {
        closed.push(id);
        void handle.dispose();
        didClose.fire({ sessionId: id });
      },
      archive: async () => {},
      restore: async () => handle,
      delete: async () => {},
      fork: async () => handle,
      createChild: async () => handle,
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    return fake;
  }

  function managerFor(fake: ReclaimFake, locks?: ISessionLockService): SessionManager {
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    return new SessionManager(workspaces, index, locks ?? new InMemorySessionLockService());
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for a session that is not live', async () => {
    const manager = managerFor(reclaimController('session-1'));
    expect(await manager.closeIfIdle('session-1', 0)).toBe(false);
    manager.dispose();
  });

  it('keeps a session before the idle timeout and closes it after', async () => {
    const fake = reclaimController('session-1');
    const manager = managerFor(fake);
    await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);

    vi.setSystemTime(Date.now() + 999);
    expect(await manager.closeIfIdle('session-1', 1000)).toBe(false);
    expect(fake.closed).toEqual([]);

    vi.setSystemTime(Date.now() + 1);
    expect(await manager.closeIfIdle('session-1', 1000)).toBe(true);
    expect(fake.closed).toEqual(['session-1']);
    expect(manager.get('session-1')).toBeUndefined();
    manager.dispose();
  });

  it('refreshes lastUsed when a resume finds the session already live', async () => {
    const fake = reclaimController('session-1');
    const manager = managerFor(fake);
    await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);

    vi.setSystemTime(Date.now() + 900);
    await manager.resume('session-1');
    expect(fake.resumeCalls).toBe(1);

    vi.setSystemTime(Date.now() + 900);
    expect(await manager.closeIfIdle('session-1', 1000)).toBe(false);
    expect(fake.closed).toEqual([]);

    vi.setSystemTime(Date.now() + 101);
    expect(await manager.closeIfIdle('session-1', 1000)).toBe(true);
    manager.dispose();
  });

  const skipCases: Array<[string, ReclaimOverrides]> = [
    ['a busy turn', { busy: true }],
    ['a pending approval', { pendingInteraction: 'approval' }],
    ['a pending question', { pendingInteraction: 'question' }],
    ['a running terminal', { terminalStatus: 'running' }],
    ['pending cron tasks', { cronTasks: 1 }],
    ['an active goal', { goalStatus: 'active' }],
  ];

  it.each(skipCases)('skips reclaim while the session has %s', async (_label, overrides) => {
    const fake = reclaimController('session-1', overrides);
    const manager = managerFor(fake);
    await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);
    expect(await manager.closeIfIdle('session-1', 0)).toBe(false);
    expect(fake.closed).toEqual([]);
    expect(manager.get('session-1')).toBeDefined();
    manager.dispose();
  });

  const allowCases: Array<[string, ReclaimOverrides]> = [
    ['an exited terminal', { terminalStatus: 'exited' }],
    ['a paused goal', { goalStatus: 'paused' }],
    ['a completed goal', { goalStatus: 'complete' }],
  ];

  it.each(allowCases)('reclaims an idle session with %s', async (_label, overrides) => {
    const fake = reclaimController('session-1', overrides);
    const manager = managerFor(fake);
    await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);
    expect(await manager.closeIfIdle('session-1', 0)).toBe(true);
    expect(manager.get('session-1')).toBeUndefined();
    manager.dispose();
  });

  it('returns false without closing when another process holds the session lock', async () => {
    const fake = reclaimController('session-1');
    const inner = new InMemorySessionLockService();
    let occupied = true;
    const locks = {
      onDidHold: Event.None,
      hold: () => {},
      tryHold: () => true,
      release: () => {},
      lease: (sessionId: string) => {
        if (occupied) throw sessionOccupiedError(sessionId);
        return inner.lease(sessionId);
      },
      held: (sessionId: string) => inner.held(sessionId),
    } as unknown as ISessionLockService;
    const manager = managerFor(fake, locks);
    await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);

    expect(await manager.closeIfIdle('session-1', 0)).toBe(false);
    expect(fake.closed).toEqual([]);
    expect(manager.get('session-1')).toBeDefined();

    occupied = false;
    expect(await manager.closeIfIdle('session-1', 0)).toBe(true);
    expect(manager.get('session-1')).toBeUndefined();
    manager.dispose();
  });

  it('releases the lease when the close path fails', async () => {
    const fake = reclaimController('session-1');
    (fake.service as unknown as { close: (id: string) => Promise<void> }).close = async () => {
      throw new Error('boom');
    };
    const locks = new InMemorySessionLockService();
    const manager = managerFor(fake, locks);
    await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);

    await expect(manager.closeIfIdle('session-1', 0)).rejects.toThrow('boom');
    expect(locks.held('session-1')).toBe(false);
    expect(manager.get('session-1')).toBeDefined();
    manager.dispose();
  });

  it('serializes a reclaim with a racing resume so the resume returns a valid handle', async () => {
    const fake = reclaimController('session-1');
    const manager = managerFor(fake);
    const first = await manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const originalClose = fake.service.close;
    (fake.service as unknown as { close: (id: string) => Promise<void> }).close = async (id: string) => {
      await closeGate;
      await originalClose(id);
    };
    fake.resumeMode = 'cold';

    const reclaim = manager.closeIfIdle('session-1', 0);
    const resumed = manager.resume('session-1');
    await drainMicrotasks();
    expect(fake.resumeCalls).toBe(0);

    releaseClose();
    expect(await reclaim).toBe(true);
    const handle = await resumed;
    expect(fake.resumeCalls).toBe(1);
    expect(handle).toBeDefined();
    expect(handle).not.toBe(first);
    expect(fake.disposed).toEqual(['session-1']);
    expect(manager.get('session-1')).toBe(handle);
    manager.dispose();
  });
});

describe('SessionManager controller retirement', () => {
  function runtime(generation: string): FakeRuntime {
    return Object.assign(
      new FakeRuntime(
        { workspaceId: 'workspace', runtimeId: 'local', generation },
        { capabilities: ['fs', 'process'] },
      ),
      { fs: {}, process: {} },
    ) as FakeRuntime;
  }

  function liveProgram(drainTimeoutMs: number): {
    readonly registry: RuntimeRegistry;
    readonly program: Program;
    readonly controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[];
  } {
    const registry = new RuntimeRegistry('workspace', drainTimeoutMs);
    const controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[] = [];
    let nextSession = 0;
    const program = new Program(
      'workspace',
      registry,
      {
        _serviceBrand: undefined,
        workspaceId: 'workspace',
        cwd: '/workspace',
        source: 'local',
        meta: {
          id: 'workspace',
          name: 'workspace',
          root: '/workspace',
          createdAt: 0,
          lastOpenedAt: 0,
        },
        persistenceScope: 'sessions/workspace',
      },
      {
        agentProfiles: { entries: () => [] },
        createSessionController: (input: ProgramSessionControllerInput) => {
          const didCreate = new Emitter<SessionCreatedEvent>();
          const didClose = new Emitter<SessionClosedEvent>();
          const didArchive = new Emitter<SessionArchivedEvent>();
          const live = new Map<string, ISessionScopeHandle>();
          const dispose = vi.fn(() => {
            input.onDispose();
            didCreate.dispose();
            didClose.dispose();
            didArchive.dispose();
          });
          const service = {
            onWillCreateSession: Event.None,
            onDidCreateSession: didCreate.event,
            onWillCloseSession: Event.None,
            onDidCloseSession: didClose.event,
            onDidArchiveSession: didArchive.event,
            onDidForkSession: Event.None,
            create: async () => {
              nextSession += 1;
              const sessionId = `session-${nextSession}`;
              const handle = { id: sessionId } as unknown as ISessionScopeHandle;
              live.set(sessionId, handle);
              didCreate.fire({ sessionId, handle, source: 'startup' });
              return handle;
            },
            get: (sessionId: string) => live.get(sessionId),
            list: () => [...live.values()],
            resume: async () => undefined,
            close: async (sessionId: string) => {
              if (live.delete(sessionId)) didClose.fire({ sessionId });
            },
            archive: async (sessionId: string) => {
              if (live.delete(sessionId)) didArchive.fire({ sessionId });
            },
            restore: async () => undefined,
            delete: async () => {},
            fork: async () => {
              throw new Error('fork not supported');
            },
            createChild: async () => {
              throw new Error('createChild not supported');
            },
            dispose,
          } as unknown as SessionLifecycleService;
          controllers.push({ service, dispose });
          return service;
        },
      } as never,
    );
    const createGeneration = vi.fn(() => {
      const lease = registry.acquire(program.binding, ['fs', 'process']);
      const id = lease.runtime.identity.generation;
      const behavior = {
        ready: Promise.resolve(),
        dispose: () => {},
      };
      const catalog = {
        listSkills: () => [],
        listInvocableSkills: () => [],
        getSkippedByPolicy: () => [],
        getSkillRoots: () => [],
      };
      return {
        id,
        lease,
        state: behavior,
        dirs: behavior,
        fs: behavior,
        watch: behavior,
        git: behavior,
        instructions: { ...behavior, snapshot: {} },
        mcpConfig: { ...behavior, servers: () => ({}) },
        mcp: behavior,
        trust: { ...behavior, isTrusted: () => false },
        skills: { ...behavior, catalog },
        agentProfiles: behavior,
        userAgentProfiles: behavior,
        pluginAgentProfiles: behavior,
        explicitAgentProfiles: behavior,
        extraAgentProfiles: behavior,
        disposables: [behavior],
        ready: false,
        failed: false,
        references: 1,
        retired: false,
      };
    });
    (program as unknown as { createGeneration: typeof createGeneration }).createGeneration = createGeneration;
    return { registry, program, controllers };
  }

  function managerFor(program: Program): SessionManager {
    const workspace = { id: 'workspace', program } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    return new SessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
      new InMemorySessionLockService(),
    );
  }

  it('releases the superseded program generation once its last session closes, before the drain timeout', async () => {
    const { registry, program, controllers } = liveProgram(60_000);
    const first = runtime('one');
    const registration = registry.register(first);
    await program.ready;
    const manager = managerFor(program);

    const handleOne = await manager.create({ workDir: '/workspace' });
    const replacement = registration.replace(runtime('two'));
    await Promise.resolve();
    const handleTwo = await manager.create({ workDir: '/workspace' });
    expect(manager.list()).toEqual([handleOne, handleTwo]);
    expect(first.disposed).toBe(false);

    await manager.close(handleOne.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).not.toHaveBeenCalled();
    await replacement;
    expect(first.disposed).toBe(true);
    expect(manager.get(handleTwo.id)).toBe(handleTwo);

    manager.dispose();
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    program.dispose();
    await registry.dispose();
  });

  it('retires an idle current-generation controller and rebuilds it for the next session', async () => {
    const { registry, program, controllers } = liveProgram(50);
    registry.register(runtime('one'));
    await program.ready;
    const manager = managerFor(program);

    const first = await manager.create({ workDir: '/workspace' });
    expect(controllers).toHaveLength(1);
    await manager.close(first.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);

    const second = await manager.create({ workDir: '/workspace' });
    expect(controllers).toHaveLength(2);
    expect(manager.get(second.id)).toBe(second);

    manager.dispose();
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    program.dispose();
    await registry.dispose();
  });
});

describe('reloadOnStale', () => {
  function staleAccessor(): {
    readonly accessor: ServicesAccessor;
    readonly order: string[];
    readonly reloaded: ISessionScopeHandle;
  } {
    const order: string[] = [];
    const reloaded = { id: 'session-1' } as unknown as ISessionScopeHandle;
    const manager = {
      close: async () => {
        order.push('close');
      },
      resume: async () => {
        order.push('resume');
        return reloaded;
      },
    };
    const accessor = {
      get: (id: unknown) => {
        if (id === ISessionManager) return manager;
        throw new Error('unexpected service');
      },
    } as unknown as ServicesAccessor;
    return { accessor, order, reloaded };
  }

  it('reloads the session and retries once after a stale rejection', async () => {
    const { accessor, order, reloaded } = staleAccessor();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error2(ErrorCodes.SESSION_STALE, 'stale'))
      .mockResolvedValue('done');
    const onReloaded = vi.fn(async (session: ISessionScopeHandle) => {
      order.push(`reloaded:${session === reloaded}`);
    });

    await expect(reloadOnStale(accessor, 'session-1', run, { onReloaded })).resolves.toBe('done');

    expect(order).toEqual(['close', 'resume', 'reloaded:true']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reloads but rethrows the stale rejection when retry is off', async () => {
    const { accessor, order } = staleAccessor();
    const stale = new Error2(ErrorCodes.SESSION_STALE, 'stale');
    const run = vi.fn(async () => {
      throw stale;
    });

    await expect(reloadOnStale(accessor, 'session-1', run, { retry: false })).rejects.toBe(stale);

    expect(order).toEqual(['close', 'resume']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes other failures through without reloading', async () => {
    const { accessor, order } = staleAccessor();
    const occupied = new Error2(ErrorCodes.SESSION_OCCUPIED, 'occupied');

    await expect(
      reloadOnStale(accessor, 'session-1', async () => {
        throw occupied;
      }),
    ).rejects.toBe(occupied);

    expect(order).toEqual([]);
  });
});
