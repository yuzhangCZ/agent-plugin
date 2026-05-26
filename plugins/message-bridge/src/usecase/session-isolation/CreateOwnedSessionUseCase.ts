import type {
  CreateOwnedSessionInput,
  HostSessionCreateInput,
} from '../../port/session-isolation/dto/commands/index.js';
import type { CreateOwnedSessionResult } from '../../port/session-isolation/dto/results/index.js';
import type { HostSessionGateway } from '../../port/session-isolation/outbound/index.js';
import type { OwnedSessionCoordinator } from './OwnedSessionCoordinator.js';

export type CreateOwnedSessionRequest = Omit<CreateOwnedSessionInput, 'sessionId'>;

/**
 * 创建受控宿主会话，并把 ownership / binding 写入委托给唯一协调器。
 */
export class DefaultCreateOwnedSessionUseCase {
  constructor(private readonly dependencies: {
    hostSessionGateway: HostSessionGateway;
    ownedSessionCoordinator: OwnedSessionCoordinator;
  }) {}

  async execute(input: CreateOwnedSessionRequest): Promise<CreateOwnedSessionResult> {
    const session = await this.dependencies.hostSessionGateway.create(this.toHostCreateInput(input));
    try {
      await this.dependencies.ownedSessionCoordinator.bindOwnedSession({
        ...input,
        sessionId: session.id,
      });
    } catch (error) {
      await this.deleteBestEffort(session.id);
      throw error;
    }
    return { session };
  }

  private async deleteBestEffort(sessionId: string): Promise<void> {
    try {
      await this.dependencies.hostSessionGateway.delete(sessionId);
    } catch {
      // ownership 写入失败时优先保留原始错误；删除失败由后续清理/日志链路兜底。
    }
  }

  private toHostCreateInput(input: CreateOwnedSessionRequest): HostSessionCreateInput {
    const controlled = input.policy?.controlled ?? true;
    return {
      ...(input.title ? { title: input.title } : {}),
      ...(input.assistantId ? { assistantId: input.assistantId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
      control: {
        controlled,
        permissionProfile: controlled ? 'dialog_only' : 'default',
      },
    };
  }
}
