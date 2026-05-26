import type { SwitchAttachedSessionInput } from '../../port/session-isolation/dto/commands/index.js';
import type { OwnedSessionMutationResult } from '../../port/session-isolation/dto/results/index.js';
import type { OwnedSessionCoordinator } from './OwnedSessionCoordinator.js';

/**
 * 切换当前 anchor 绑定的宿主会话，状态写入统一委托给 coordinator。
 */
export class DefaultSwitchAttachedSessionUseCase {
  constructor(private readonly dependencies: {
    ownedSessionCoordinator: OwnedSessionCoordinator;
  }) {}

  execute(input: SwitchAttachedSessionInput): Promise<OwnedSessionMutationResult> {
    return this.dependencies.ownedSessionCoordinator.switchAttachedSession(input);
  }
}
