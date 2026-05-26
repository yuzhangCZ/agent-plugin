import crypto from 'node:crypto';

import type {
  BusinessEntryKey,
} from '../../domain/session-isolation/index.js';
import type {
  CreateSessionCommandInput,
  HostSessionCreateInput,
} from '../../port/session-isolation/dto/commands/index.js';
import type {
  CreateSessionCommandResult,
} from '../../port/session-isolation/dto/results/index.js';
import type {
      HostSessionGateway,
} from '../../port/session-isolation/outbound/index.js';
import type { CreateOwnedSessionInput } from '../../port/session-isolation/dto/commands/index.js';
import type { OwnedSessionCoordinator } from './OwnedSessionCoordinator.js';
import type { BusinessEntryKeyResolver } from './ChatCommandUseCase.js';

export interface RuntimeAnchorRepository {
  createAnchorOnly(input: { toolSessionId: string }): Promise<void>;
  delete(toolSessionId: string): Promise<void>;
  isAnchorOnly(toolSessionId: string): Promise<boolean>;
}

/**
 * create_session 控制面入口：创建宿主会话，并在可解析业务入口时建立正式 ownership。
 * @remarks 兼容期仍以新建宿主会话 id 作为 toolSessionId/anchor，保持现有 gateway 回包语义。
 */
export class DefaultCreateSessionCommandUseCase {
  constructor(private readonly dependencies: {
    businessEntryKeyResolver: BusinessEntryKeyResolver;
    hostSessionGateway: Pick<HostSessionGateway, 'create' | 'delete'>;
    ownedSessionCoordinator: Pick<OwnedSessionCoordinator, 'bindOwnedSession'>;
    runtimeAnchorRepository?: Pick<RuntimeAnchorRepository, 'createAnchorOnly'>;
    toolSessionIdFactory?: () => string;
  }) {}

  async execute(input: CreateSessionCommandInput): Promise<CreateSessionCommandResult> {
    const entryKey = this.dependencies.businessEntryKeyResolver.resolve({
      source: 'create_session',
      welinkSessionId: input.welinkSessionId,
      extParameters: input.extParameters,
    });
    if (!entryKey) {
      const toolSessionId = this.dependencies.toolSessionIdFactory?.() ?? crypto.randomUUID();
      await this.dependencies.runtimeAnchorRepository?.createAnchorOnly({ toolSessionId });
      return {
        kind: 'anchor_only',
        toolSessionId,
      };
    }

    const session = await this.dependencies.hostSessionGateway.create(this.toHostCreateInput(input, entryKey));
    try {
      await this.dependencies.ownedSessionCoordinator.bindOwnedSession(this.toCreateOwnedInput(input, entryKey, session.id));
    } catch (error) {
      await this.deleteBestEffort(session.id);
      throw error;
    }
    return {
      kind: 'entry_owned',
      toolSessionId: session.id,
      session,
    };
  }

  private async deleteBestEffort(sessionId: string): Promise<void> {
    try {
      await this.dependencies.hostSessionGateway.delete(sessionId);
    } catch {
      // ownership 写入失败时优先保留原始错误；删除失败由后续清理/日志链路兜底。
    }
  }

  private toHostCreateInput(
    input: CreateSessionCommandInput,
    entryKey: BusinessEntryKey | undefined,
  ): HostSessionCreateInput {
    return {
      ...(input.title ? { title: input.title } : {}),
      ...(input.assistantId ? { assistantId: input.assistantId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
      control: {
        controlled: Boolean(entryKey),
        permissionProfile: entryKey ? 'dialog_only' : 'default',
      },
    };
  }

  private toCreateOwnedInput(
    input: CreateSessionCommandInput,
    entryKey: BusinessEntryKey,
    sessionId: string,
  ): CreateOwnedSessionInput {
    return {
      toolSessionId: sessionId,
      sessionId,
      entryKey,
      ...(input.title ? { title: input.title } : {}),
      ...(input.assistantId ? { assistantId: input.assistantId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    };
  }
}
