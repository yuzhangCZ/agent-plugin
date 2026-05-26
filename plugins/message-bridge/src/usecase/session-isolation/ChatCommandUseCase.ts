import type { BusinessEntryKey } from '../../domain/session-isolation/index.js';
import type {
  ChatCommandInput,
  SwitchAttachedSessionInput,
} from '../../port/session-isolation/dto/commands/index.js';
import type {
  ChatCommandResult,
  CreateOwnedSessionResult,
  OwnedSessionMutationResult,
  ResolvedEntrySessionContext,
} from '../../port/session-isolation/dto/results/index.js';
import type { ChatCommandPort } from '../../port/session-isolation/inbound/index.js';
import type { HostSessionGateway } from '../../port/session-isolation/outbound/index.js';
import type { CreateOwnedSessionRequest } from './CreateOwnedSessionUseCase.js';

export interface BusinessEntryKeyResolver {
  resolve(input: Pick<ChatCommandInput, 'welinkSessionId' | 'extParameters'> & {
    source?: 'chat' | 'create_session';
    context?: {
      assistantAccount?: string;
      sendUserAccount?: string;
      imGroupId?: string;
    };
  }): BusinessEntryKey | undefined;
}

interface ResolveEntrySessionContextUseCase {
  execute(input: {
    toolSessionId: string;
    entryKey: BusinessEntryKey;
    directory?: string;
  }): Promise<ResolvedEntrySessionContext>;
}

interface SwitchAttachedSessionUseCase {
  execute(input: SwitchAttachedSessionInput): Promise<OwnedSessionMutationResult>;
}

interface CreateOwnedSessionUseCase {
  execute(input: CreateOwnedSessionRequest): Promise<CreateOwnedSessionResult>;
}

/**
 * chat 控制面入口：解析业务入口、收敛可见会话，并把 prompt 限定在当前入口可见范围内。
 */
export class DefaultChatCommandUseCase implements ChatCommandPort {
  constructor(private readonly dependencies: {
    businessEntryKeyResolver: BusinessEntryKeyResolver;
    resolveEntrySessionContextUseCase: ResolveEntrySessionContextUseCase;
    switchAttachedSessionUseCase: SwitchAttachedSessionUseCase;
    createOwnedSessionUseCase: CreateOwnedSessionUseCase;
    hostSessionGateway: HostSessionGateway;
  }) {}

  async execute(input: ChatCommandInput): Promise<ChatCommandResult> {
    const entryKey = this.dependencies.businessEntryKeyResolver.resolve({
      source: 'chat',
      welinkSessionId: input.welinkSessionId,
      extParameters: input.extParameters,
    });
    if (!entryKey) {
      throw new Error('business entry key required');
    }

    const context = await this.dependencies.resolveEntrySessionContextUseCase.execute({
      toolSessionId: input.toolSessionId,
      entryKey,
    });
    const session = context.session ?? await this.attachOrCreateSession(input, entryKey, context);

    await this.dependencies.hostSessionGateway.prompt({
      sessionId: session.id,
      text: input.text,
      ...(input.assistantId ? { assistantId: input.assistantId } : {}),
    });
    return {
      kind: 'prompted',
      toolSessionId: input.toolSessionId,
      sessionId: session.id,
    };
  }

  private async attachOrCreateSession(
    input: ChatCommandInput,
    entryKey: BusinessEntryKey,
    context: ResolvedEntrySessionContext,
  ) {
    const visibleSession = context.visibleSessions[0];
    if (visibleSession) {
      await this.dependencies.switchAttachedSessionUseCase.execute({
        toolSessionId: input.toolSessionId,
        sessionId: visibleSession.id,
      });
      return visibleSession;
    }

    const created = await this.dependencies.createOwnedSessionUseCase.execute({
      toolSessionId: input.toolSessionId,
      entryKey,
      ...(input.assistantId ? { assistantId: input.assistantId } : {}),
    });
    return created.session;
  }
}
