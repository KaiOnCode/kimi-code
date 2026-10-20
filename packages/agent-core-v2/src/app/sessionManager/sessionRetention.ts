import { collection } from '#/_base/di/collection';
import type { ISessionScopeHandle } from '#/_base/di/scope';

export interface SessionRetentionContribution {
  readonly name: string;
  readonly retains: (session: ISessionScopeHandle) => boolean | Promise<boolean>;
}

export const SessionRetentionContribution =
  collection<SessionRetentionContribution>('session-retention');
