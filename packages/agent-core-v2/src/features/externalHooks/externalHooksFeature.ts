import { LifecycleScope } from '#/app/scopes';
import { SessionRetentionContribution } from '#/app/sessionManager/sessionRetention';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './configSection';
import { IAgentExternalHooksService } from './agent/agentExternalHooks';
import { AgentExternalHooksService } from './agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from './app/externalHooksRunner';
import { ExternalHooksRunnerService } from './app/externalHooksRunnerService';
import { ISessionExternalHooksService } from './session/sessionExternalHooks';
import { SessionExternalHooksService } from './session/sessionExternalHooksService';

export const externalHooksSessionRetention: SessionRetentionContribution = {
  name: 'externalHooks',
  retains: async (session) => {
    const hooks = session.accessor.get(IExternalHooksRunnerService);
    await hooks.ready;
    return ['SessionStart', 'SessionEnd', 'SessionHeartbeat'].some((event) => hooks.hasHooksFor(event));
  },
};

export class ExternalHooksFeature extends Feature {
  static override readonly name = 'externalHooks';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.App,
      IExternalHooksRunnerService,
      ExternalHooksRunnerService,
    );
    this.contributeService(
      LifecycleScope.Session,
      ISessionExternalHooksService,
      SessionExternalHooksService,
    );
    this.contributeAgentService(IAgentExternalHooksService, AgentExternalHooksService);
    this.contribute(SessionRetentionContribution, externalHooksSessionRetention);
  }
}

registerFeature(ExternalHooksFeature);
