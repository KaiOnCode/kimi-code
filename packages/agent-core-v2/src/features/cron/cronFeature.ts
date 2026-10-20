import { SessionRetentionContribution } from '#/app/sessionManager/sessionRetention';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentCronService, IAgentCronService } from '#/features/cron/cronService';
import { ICronCreateTool } from '#/features/cron/tools/cron-create/cron-create';
import { CronCreateTool } from '#/features/cron/tools/cron-create/cronCreateTool';
import { ICronDeleteTool } from '#/features/cron/tools/cron-delete/cron-delete';
import { CronDeleteTool } from '#/features/cron/tools/cron-delete/cronDeleteTool';
import { ICronListTool } from '#/features/cron/tools/cron-list/cron-list';
import { CronListTool } from '#/features/cron/tools/cron-list/cronListTool';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export const cronSessionRetention: SessionRetentionContribution = {
  name: 'cron',
  retains: (session) => {
    const agents = session.accessor.get(IAgentLifecycleService);
    return agents
      .list()
      .some((agent) => (agents.handleOf(agent.agentId)?.accessor.get(IAgentCronService).list().length ?? 0) > 0);
  },
};

export class CronFeature extends Feature {
  static override readonly name = 'cron';

  constructor() {
    super();
    this.contributeAgentService(IAgentCronService, AgentCronService);
    this.contribute(SessionRetentionContribution, cronSessionRetention);
    this.contributeTool(ICronCreateTool, CronCreateTool, { name: 'CronCreate', domain: 'cron' });
    this.contributeTool(ICronListTool, CronListTool, { name: 'CronList', domain: 'cron' });
    this.contributeTool(ICronDeleteTool, CronDeleteTool, { name: 'CronDelete', domain: 'cron' });
  }
}

registerFeature(CronFeature);
