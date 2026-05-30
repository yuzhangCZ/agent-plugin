import type { ProviderRunMessageInput } from '@wecode/bridge-runtime-sdk';
import type { HostSessionRecord } from '../../../port/session-isolation/dto/records/index.js';
import type { BusinessEntryPolicy } from '../../../port/session-isolation/dto/commands/index.js';
import type { ResolvedEntrySessionContext } from '../../../port/session-isolation/dto/results/index.js';
import type { BusinessEntryKeyResolver } from '../../../usecase/session-isolation/index.js';
import type { CreateOwnedSessionRequest } from '../../../usecase/session-isolation/CreateOwnedSessionUseCase.js';
import type { RuntimeAnchorRepository } from '../../../usecase/session-isolation/CreateSessionCommandUseCase.js';
import type { BridgeLogger } from '../../AppLogger.js';
import type { ChatExecutionContext } from '../SdkChatControlPlane.js';
import type { BusinessEntryContext } from './BusinessEntryContextResolver.js';

type ResolveEntrySessionContextUseCase = {
    execute(input: {
      toolSessionId: string;
      entryKey: NonNullable<ReturnType<BusinessEntryKeyResolver['resolve']>>;
      policy: BusinessEntryPolicy;
      directory?: string;
    }): Promise<ResolvedEntrySessionContext>;
  };

type SwitchAttachedSessionUseCase = {
  execute(input: { toolSessionId: string; sessionId: string }): Promise<{ applied: true }>;
};

type CreateOwnedSessionUseCase = {
  execute(input: CreateOwnedSessionRequest): Promise<{ session: HostSessionRecord }>;
};

type SessionModelOverrideStore = {
  get(opencodeSessionId: string): { providerId: string; modelId: string } | undefined;
};

function stringifyEntryKey(entryKey: BusinessEntryContext['entryKey']): string {
  return `${entryKey.businessSessionDomain.toLowerCase()}:${entryKey.businessSessionType.toLowerCase()}:${entryKey.businessSessionId}`;
}

/**
 * normal chat 的业务入口隔离解析器。
 * @remarks 这里只决定当前 prompt 应落到哪个 host session；fact streaming 仍由 provider 主链负责。
 */
export class EntryAwareChatSessionResolver {
  constructor(private readonly dependencies: {
    businessEntryKeyResolver: BusinessEntryKeyResolver;
    resolveEntrySessionContextUseCase: ResolveEntrySessionContextUseCase;
    switchAttachedSessionUseCase: SwitchAttachedSessionUseCase;
    createOwnedSessionUseCase: CreateOwnedSessionUseCase;
    runtimeAnchorRepository: RuntimeAnchorRepository;
    modelOverrideStore: SessionModelOverrideStore;
  }) {}

  async resolve(input: {
    message: ProviderRunMessageInput;
    entryContext?: BusinessEntryContext;
    directory?: string;
    logger?: BridgeLogger;
  }): Promise<ChatExecutionContext> {
    const entryKey = input.entryContext?.entryKey ?? this.dependencies.businessEntryKeyResolver.resolve({
      source: 'chat',
      welinkSessionId: input.message.traceId,
      extParameters: input.message.extParameters,
      context: input.message.context,
    });
    if (!entryKey) {
      throw new Error('business_entry_key_required');
    }

    const context = await this.dependencies.resolveEntrySessionContextUseCase.execute({
      toolSessionId: input.message.toolSessionId,
      entryKey,
      policy: input.entryContext?.policy ?? {
        entryKey: '',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'models', 'model'],
      },
      ...(input.directory ? { directory: input.directory } : {}),
    });
    const existingSession = context.session;
    const visibleSessionIds = context.visibleSessions.map((session) => session.id);
    const bindingSessionId = context.bindingSessionId;
    const serializedEntryKey = input.entryContext?.policy.entryKey || stringifyEntryKey(entryKey);
    if (existingSession) {
      await this.clearAnchorOnly(input.message.toolSessionId);
      input.logger?.info('sdk_chat_context.entry_existing_binding', {
        anchor: input.message.toolSessionId,
        opencodeSessionId: existingSession.id,
        entryKey: serializedEntryKey,
        directory: input.directory,
        visibleSessionIds,
        bindingSessionId,
      });
      return this.toChatExecutionContext(existingSession, 'existing_binding');
    }

    const isAnchorOnly = await this.dependencies.runtimeAnchorRepository.isAnchorOnly(input.message.toolSessionId);
    if (isAnchorOnly) {
      const created = await this.dependencies.createOwnedSessionUseCase.execute({
        toolSessionId: input.message.toolSessionId,
        entryKey,
        policy: input.entryContext?.policy ?? {
          entryKey: '',
          controlled: true,
          allowOpencodeNativeSessions: false,
          allowedSlashCommands: ['new', 'models', 'model'],
        },
        ...(input.message.assistantId ? { assistantId: input.message.assistantId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
      });
      await this.clearAnchorOnly(input.message.toolSessionId);
      input.logger?.info('sdk_chat_context.entry_created_from_anchor_only', {
        anchor: input.message.toolSessionId,
        opencodeSessionId: created.session.id,
        entryKey: serializedEntryKey,
        directory: input.directory,
        visibleSessionIds,
        bindingSessionId,
      });
      return this.toChatExecutionContext(created.session, 'bootstrap_created');
    }

    const visibleSession = context.visibleSessions[0];
    if (visibleSession) {
      await this.dependencies.switchAttachedSessionUseCase.execute({
        toolSessionId: input.message.toolSessionId,
        sessionId: visibleSession.id,
      });
      await this.clearAnchorOnly(input.message.toolSessionId);
      input.logger?.info('sdk_chat_context.entry_reused_visible_session', {
        anchor: input.message.toolSessionId,
        opencodeSessionId: visibleSession.id,
        entryKey: serializedEntryKey,
        directory: input.directory,
        visibleSessionIds,
        bindingSessionId,
      });
      return this.toChatExecutionContext(visibleSession, 'bootstrap_reused_recent_session');
    }

    const created = await this.dependencies.createOwnedSessionUseCase.execute({
      toolSessionId: input.message.toolSessionId,
      entryKey,
      policy: input.entryContext?.policy ?? {
        entryKey: '',
        controlled: true,
        allowOpencodeNativeSessions: false,
        allowedSlashCommands: ['new', 'models', 'model'],
      },
      ...(input.message.assistantId ? { assistantId: input.message.assistantId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    });
    await this.clearAnchorOnly(input.message.toolSessionId);
    input.logger?.info('sdk_chat_context.entry_created', {
      anchor: input.message.toolSessionId,
      opencodeSessionId: created.session.id,
      entryKey: serializedEntryKey,
      directory: input.directory,
      visibleSessionIds,
      bindingSessionId,
    });
    return this.toChatExecutionContext(created.session, 'bootstrap_created');
  }

  private async clearAnchorOnly(toolSessionId: string): Promise<void> {
    if (await this.dependencies.runtimeAnchorRepository.isAnchorOnly(toolSessionId)) {
      await this.dependencies.runtimeAnchorRepository.delete(toolSessionId);
    }
  }

  private toChatExecutionContext(
    session: HostSessionRecord,
    bootstrapSource: ChatExecutionContext['bootstrapSource'],
  ): ChatExecutionContext {
    return {
      opencodeSessionId: session.id,
      session,
      scope: this.buildScope(session),
      modelOverride: this.dependencies.modelOverrideStore.get(session.id),
      bootstrapSource,
    };
  }

  private buildScope(session: HostSessionRecord): ChatExecutionContext['scope'] {
    const scope = {
      ...(session.projectID ? { projectID: session.projectID } : {}),
      ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
      ...(session.directory ? { directory: session.directory } : {}),
    };
    return Object.keys(scope).length > 0 ? scope : undefined;
  }
}
