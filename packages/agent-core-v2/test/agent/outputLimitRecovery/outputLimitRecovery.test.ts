import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { OUTPUT_LIMIT_RECOVERY_VARIANT } from '#/agent/outputLimitRecovery/outputLimitRecovery';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
import type { ToolCall } from '#human/llm/message';

import { createTestAgent, type TestAgentContext } from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { submitPromptTurn } from '../loop/stubs';

describe('output-limit recovery', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;
  let records: TelemetryRecord[];

  beforeEach(async () => {
    records = [];
    ctx = createTestAgent({
      telemetry: recordingTelemetry(records),
    });
    await ctx.restorePersisted();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
    profile.update({ activeToolNames: [] });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function recoveryInjections(): ContextMessage[] {
    return ctx.context
      .get()
      .filter(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === OUTPUT_LIMIT_RECOVERY_VARIANT,
      );
  }

  function textOf(message: ContextMessage | undefined): string {
    return (message?.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  it('continues a think-only truncation with the reminder and preserved history', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'unfinished thought' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    const history = ctx.llmCalls[1]!.history;
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(history.at(-2)?.content).toMatchObject([{ type: 'think', think: 'unfinished thought' }]);
    expect(textOf(history.at(-1) as ContextMessage | undefined)).toBe(
      '<system-reminder>\n' +
        'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.' +
        '\n</system-reminder>',
    );
    expect(recoveryInjections()).toHaveLength(1);
  });

  it('resumes signed thinking without adding a reminder', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'signed unfinished thought', encrypted: 'signature' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(ctx.llmCalls[1]!.history.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(recoveryInjections()).toEqual([]);
    const events = records.filter((record) => record.event === 'llm_output_limit_recovery');
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ action: 'resumed', attempt: 1, step_no: 1 });
  });

  it('continues partial visible output with the reminder', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial answer' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const history = ctx.llmCalls[1]!.history;
    expect(history.at(-2)?.content).toMatchObject([{ type: 'text', text: 'partial answer' }]);
    expect(textOf(history.at(-1) as ContextMessage | undefined)).toContain('Output token limit hit.');
  });

  it('fails after three recovery steps and reports actions without response content', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({
      telemetry: recordingTelemetry(records),
    });
    try {
      await local.restorePersisted();
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      for (let index = 1; index <= 4; index++) {
        local.mockNextProviderResponse({
          parts: [{ type: 'think', think: `secret thought ${index}` }],
          finishReason: 'truncated',
          rawFinishReason: 'length',
          traceId: `trace-output-${index}`,
        });
      }

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(4);
      const result = await turn.result;
      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect((result.error as { code?: unknown }).code).toBe('provider.api_error');
      }
      const events = records.filter((record) => record.event === 'llm_output_limit_recovery');
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.properties?.['action'])).toEqual([
        'nudged',
        'nudged',
        'nudged',
        'exhausted',
      ]);
      expect(events.map((event) => event.properties?.['attempt'])).toEqual([1, 2, 3, 3]);
      expect(events.map((event) => event.properties?.['step_no'])).toEqual([1, 2, 3, 4]);
      expect(events[0]?.properties).toMatchObject({
        turn_id: 0,
        model: 'mock-model',
        provider_type: 'kimi',
        protocol: 'openai',
        trace_id: 'trace-output-1',
      });
      expect(events[3]?.properties).toMatchObject({ trace_id: 'trace-output-4' });
      for (const event of events) {
        expect(JSON.stringify(event.properties)).not.toContain('secret thought');
      }
    } finally {
      await local.dispose();
    }
  });

  it('allows recovery steps past maxSteps', async () => {
    const local = createTestAgent({
      initialConfig: {
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    try {
      await local.restorePersisted();
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'think', think: 'unfinished thought' }],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });
      local.mockNextResponse({ type: 'text', text: 'completed answer' });

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(2);
      await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    } finally {
      await local.dispose();
    }
  });

  it('resets the recovery count after a tool-driven next turn', async () => {
    const lookupCall = registerLookupTool(ctx);
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'first truncation' }],
      finishReason: 'truncated',
    });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'second truncation' }],
      finishReason: 'truncated',
    });
    ctx.mockNextResponse({ type: 'text', text: 'calling a tool' }, lookupCall);
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'third truncation' }],
      finishReason: 'truncated',
    });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'fourth truncation' }],
      finishReason: 'truncated',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const { turn } = submitTurn(loop, 'Look up mars');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(6);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 6, truncated: false });
    expect(recoveryInjections()).toHaveLength(4);
  });

  it('lets cancellation take precedence over the queued recovery', async () => {
    loop.hooks.onDidFinishStep.register('test-cancel-turn', async (_hookCtx, next) => {
      loop.cancel();
      await next();
    });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'unfinished thought' }],
      finishReason: 'truncated',
    });
    ctx.mockNextResponse({ type: 'text', text: 'should not run' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const result = await turn.result;
    expect(result.type).toBe('cancelled');
    expect(recoveryInjections()).toEqual([]);
  });
});

function registerLookupTool(agent: TestAgentContext): ToolCall {
  const lookupCall: ToolCall = {
    type: 'function',
    id: 'call_lookup',
    name: 'Lookup',
    arguments: '{"query":"mars"}',
  };
  const lookupTool: ExecutableTool<{ query: string }> = {
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    resolveExecution: () => ({
      approvalRule: 'Lookup',
      execute: async () => ({ output: 'lookup-result' }),
    }),
  };
  agent.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
  agent.get(IAgentToolRegistryService).register(lookupTool);
  return lookupCall;
}

function submitTurn(loop: IAgentLoopService, text: string): { readonly turn: Turn } {
  return submitPromptTurn(loop, {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { origin: { kind: 'user' } },
  });
}
