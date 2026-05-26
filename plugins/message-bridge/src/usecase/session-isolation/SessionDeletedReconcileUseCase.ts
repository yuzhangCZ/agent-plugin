import type { SessionDeletedEventInput } from '../../port/session-isolation/dto/commands/index.js';
import type { OwnedSessionMutationResult } from '../../port/session-isolation/dto/results/index.js';
import type { OwnedSessionCoordinator } from './OwnedSessionCoordinator.js';

/**
 * session.deleted 回流后的幂等补偿入口，清理逻辑统一委托给 coordinator。
 */
export class DefaultSessionDeletedReconcileUseCase {
  constructor(private readonly dependencies: {
    ownedSessionCoordinator: OwnedSessionCoordinator;
  }) {}

  execute(input: SessionDeletedEventInput): Promise<OwnedSessionMutationResult> {
    return this.dependencies.ownedSessionCoordinator.reconcileDeletedSession(input);
  }
}
