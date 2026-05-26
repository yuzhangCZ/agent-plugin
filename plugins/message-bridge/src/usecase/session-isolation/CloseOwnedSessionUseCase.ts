import type { CloseOwnedSessionInput } from '../../port/session-isolation/dto/commands/index.js';
import type { CloseOwnedSessionResult } from '../../port/session-isolation/dto/results/index.js';
import type {
  AnchorBindingRepository,
  HostSessionGateway,
} from '../../port/session-isolation/outbound/index.js';
import type { CloseSessionCommandPort } from '../../port/session-isolation/inbound/index.js';
import type { OwnedSessionCoordinator } from './OwnedSessionCoordinator.js';
import type { RuntimeAnchorRepository } from './CreateSessionCommandUseCase.js';

/**
 * 关闭受控宿主会话：先调用 host delete，再由 coordinator 做本地 ownership cleanup。
 */
export class DefaultCloseOwnedSessionUseCase implements CloseSessionCommandPort {
  constructor(private readonly dependencies: {
    anchorBindingRepository: AnchorBindingRepository;
    hostSessionGateway: HostSessionGateway;
    ownedSessionCoordinator: OwnedSessionCoordinator;
    runtimeAnchorRepository?: Pick<RuntimeAnchorRepository, 'delete' | 'isAnchorOnly'>;
  }) {}

  async execute(input: CloseOwnedSessionInput): Promise<CloseOwnedSessionResult> {
    const runtimeAnchorRepository = this.dependencies.runtimeAnchorRepository;
    if (runtimeAnchorRepository && await runtimeAnchorRepository.isAnchorOnly(input.toolSessionId)) {
      await runtimeAnchorRepository.delete(input.toolSessionId);
      return { kind: 'not_bound' };
    }

    const binding = await this.dependencies.anchorBindingRepository.get(input.toolSessionId);
    if (!binding?.sessionId) {
      await this.dependencies.ownedSessionCoordinator.closeOwnedSession(input);
      return { kind: 'not_bound' };
    }

    await this.dependencies.hostSessionGateway.delete(binding.sessionId);
    await this.dependencies.ownedSessionCoordinator.closeOwnedSession(input);
    return {
      kind: 'closed',
      sessionId: binding.sessionId,
    };
  }
}
