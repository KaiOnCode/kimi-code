import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import { IFlagService } from '#/app/flag/flag';
import type { LlmOutputLimitRecoveryEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ChatProviderError } from '#/llm-adapter/contract/errors';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';

import {
  IAgentOutputLimitRecoveryService,
  OUTPUT_LIMIT_RECOVERY_FLAG_ID,
  OUTPUT_LIMIT_RECOVERY_VARIANT,
} from './outputLimitRecovery';

const MAX_OUTPUT_LIMIT_RECOVERIES = 3;
const OUTPUT_LIMIT_RECOVERY_REMINDER =
  'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.';

export class AgentOutputLimitRecoveryService
  extends Disposable
  implements IAgentOutputLimitRecoveryService
{
  declare readonly _serviceBrand: undefined;

  private turnId: number | undefined;
  private recoveries = 0;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IFlagService private readonly flags: IFlagService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(
      loop.hooks.onDidFinishStep.register('outputLimitRecovery', async (ctx, next) => {
        this.recover(ctx);
        await next();
      }),
    );
  }

  private recover(ctx: AfterStepContext): void {
    if (ctx.finishReason === 'tool_calls') {
      this.turnId = undefined;
      this.recoveries = 0;
      return;
    }
    if (!this.flags.enabled(OUTPUT_LIMIT_RECOVERY_FLAG_ID) || ctx.finishReason !== 'truncated') {
      return;
    }
    const message = this.context.get().findLast((entry) => entry.role === 'assistant');
    if (message === undefined || message.toolCalls.length > 0 || message.content.length === 0) {
      return;
    }
    if (this.turnId !== ctx.turnId) {
      this.turnId = ctx.turnId;
      this.recoveries = 0;
    }
    if (this.recoveries >= MAX_OUTPUT_LIMIT_RECOVERIES) {
      ctx.failTurn = new ChatProviderError(
        'The model did not complete the response after three output-limit recovery attempts. Increase max_completion_tokens or lower the thinking effort.',
      );
      this.track(ctx, 'exhausted', this.recoveries);
      return;
    }
    this.recoveries += 1;
    const part = message.content.length === 1 ? message.content[0] : undefined;
    const canResume =
      part?.type === 'think' && part.encrypted !== undefined && part.encrypted.length > 0;
    if (canResume) {
      this.loop.notify({ bypassMaxSteps: true });
    } else {
      this.loop.notify({
        message: {
          role: 'user',
          content: [{ type: 'text', text: wrapSystemReminder(OUTPUT_LIMIT_RECOVERY_REMINDER) }],
          toolCalls: [],
          origin: {
            kind: 'injection',
            variant: OUTPUT_LIMIT_RECOVERY_VARIANT,
            ownerPromptId: this.loop.snapshot().activePromptId,
          },
        },
        bypassMaxSteps: true,
      });
    }
    this.track(ctx, canResume ? 'resumed' : 'nudged', this.recoveries);
  }

  private track(
    ctx: AfterStepContext,
    action: LlmOutputLimitRecoveryEvent['action'],
    attempt: number,
  ): void {
    const properties: LlmOutputLimitRecoveryEvent = {
      turn_id: ctx.turnId,
      step_no: ctx.step,
      action,
      attempt,
      model: this.llmRequester.lastTurnRequest()?.modelAlias,
    };
    this.telemetry.track2('llm_output_limit_recovery', properties);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentOutputLimitRecoveryService,
  AgentOutputLimitRecoveryService,
  ScopeActivation.OnScopeCreated,
  'outputLimitRecovery',
);
