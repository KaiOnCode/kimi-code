import { createDecorator } from '#/_base/di/instantiation';
import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const OUTPUT_LIMIT_RECOVERY_VARIANT = 'output_limit_recovery';
export const OUTPUT_LIMIT_RECOVERY_FLAG_ID = 'output_limit_recovery';
export const OUTPUT_LIMIT_RECOVERY_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_OUTPUT_LIMIT_RECOVERY';

export const outputLimitRecoveryFlag: FlagDefinitionInput = {
  id: OUTPUT_LIMIT_RECOVERY_FLAG_ID,
  title: 'Output-limit recovery',
  description:
    'Preserve truncated assistant output and continue it up to three times, using direct continuation for signed thinking and an output-limit reminder otherwise.',
  env: OUTPUT_LIMIT_RECOVERY_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(outputLimitRecoveryFlag);

export interface IAgentOutputLimitRecoveryService {
  readonly _serviceBrand: undefined;
}

export const IAgentOutputLimitRecoveryService =
  createDecorator<IAgentOutputLimitRecoveryService>('agentOutputLimitRecoveryService');
