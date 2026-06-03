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

type ResolvedBusinessEntryKey = NonNullable<ReturnType<BusinessEntryKeyResolver['resolve']>>;

type EntryAwareResolveInput = {
  message: ProviderRunMessageInput;
  entryContext?: BusinessEntryContext;
  directory?: string;
  logger?: BridgeLogger;
};

type EntryResolutionLogContext = {
  entryKey: string;
  directory?: string;
  visibleSessionIds: string[];
  bindingSessionId?: string;
};

const DEFAULT_CHAT_ENTRY_POLICY: BusinessEntryPolicy = {
  entryKey: '',
  controlled: true,
  allowOpencodeNativeSessions: false,
  allowedSlashCommands: ['new', 'models', 'model'],
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

  async resolve(input: EntryAwareResolveInput): Promise<ChatExecutionContext> {
    const entryKey = this.resolveEntryKey(input);
    const policy = input.entryContext?.policy ?? DEFAULT_CHAT_ENTRY_POLICY;
    const context = await this.resolveEntrySessionContext(input, entryKey, policy);
    const logContext = this.buildLogContext(input, context, entryKey);

    if (context.session) {
      return this.useExistingSession(input, context.session, logContext);
    }

    if (await this.dependencies.runtimeAnchorRepository.isAnchorOnly(input.message.toolSessionId)) {
      return this.createSession(input, entryKey, policy, 'sdk_chat_context.entry_created_from_anchor_only', logContext);
    }

    const visibleSession = context.visibleSessions[0];
    if (visibleSession) {
      return this.useVisibleSession(input, visibleSession, logContext);
    }

    return this.createSession(input, entryKey, policy, 'sdk_chat_context.entry_created', logContext);
  }

  private resolveEntryKey(input: EntryAwareResolveInput): ResolvedBusinessEntryKey {
    const entryKey = input.entryContext?.entryKey ?? this.dependencies.businessEntryKeyResolver.resolve({
      source: 'chat',
      welinkSessionId: input.message.traceId,
      extParameters: input.message.extParameters,
      context: input.message.context,
    });
    if (!entryKey) {
      throw new Error('business_entry_key_required');
    }
    return entryKey;
  }

  private resolveEntrySessionContext(
    input: EntryAwareResolveInput,
    entryKey: ResolvedBusinessEntryKey,
    policy: BusinessEntryPolicy,
  ): Promise<ResolvedEntrySessionContext> {
    return this.dependencies.resolveEntrySessionContextUseCase.execute({
      toolSessionId: input.message.toolSessionId,
      entryKey,
      policy,
      ...(input.directory ? { directory: input.directory } : {}),
    });
  }

  private buildLogContext(
    input: EntryAwareResolveInput,
    context: ResolvedEntrySessionContext,
    entryKey: ResolvedBusinessEntryKey,
  ): EntryResolutionLogContext {
    return {
      entryKey: input.entryContext?.policy.entryKey || stringifyEntryKey(entryKey),
      ...(input.directory ? { directory: input.directory } : {}),
      visibleSessionIds: context.visibleSessions.map((session) => session.id),
      ...(context.bindingSessionId ? { bindingSessionId: context.bindingSessionId } : {}),
    };
  }

  private async useExistingSession(
    input: EntryAwareResolveInput,
    session: HostSessionRecord,
    logContext: EntryResolutionLogContext,
  ): Promise<ChatExecutionContext> {
    // existing binding 也要刷新 attached owner，避免共享 host session 的 TUI 回流停留在旧 anchor。
    await this.dependencies.switchAttachedSessionUseCase.execute({
      toolSessionId: input.message.toolSessionId,
      sessionId: session.id,
    });
    await this.clearAnchorOnly(input.message.toolSessionId);
    input.logger?.info('sdk_chat_context.entry_existing_binding', {
      anchor: input.message.toolSessionId,
      opencodeSessionId: session.id,
      ...logContext,
    });
    return this.toChatExecutionContext(session, 'existing_binding');
  }

  private async useVisibleSession(
    input: EntryAwareResolveInput,
    session: HostSessionRecord,
    logContext: EntryResolutionLogContext,
  ): Promise<ChatExecutionContext> {
    await this.dependencies.switchAttachedSessionUseCase.execute({
      toolSessionId: input.message.toolSessionId,
      sessionId: session.id,
    });
    await this.clearAnchorOnly(input.message.toolSessionId);
    input.logger?.info('sdk_chat_context.entry_reused_visible_session', {
      anchor: input.message.toolSessionId,
      opencodeSessionId: session.id,
      ...logContext,
    });
    return this.toChatExecutionContext(session, 'bootstrap_reused_recent_session');
  }

  private async createSession(
    input: EntryAwareResolveInput,
    entryKey: ResolvedBusinessEntryKey,
    policy: BusinessEntryPolicy,
    logMessage: 'sdk_chat_context.entry_created_from_anchor_only' | 'sdk_chat_context.entry_created',
    logContext: EntryResolutionLogContext,
  ): Promise<ChatExecutionContext> {
    const created = await this.dependencies.createOwnedSessionUseCase.execute({
      toolSessionId: input.message.toolSessionId,
      entryKey,
      policy,
      ...(input.message.assistantId ? { assistantId: input.message.assistantId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    });
    await this.clearAnchorOnly(input.message.toolSessionId);
    input.logger?.info(logMessage, {
      anchor: input.message.toolSessionId,
      opencodeSessionId: created.session.id,
      ...logContext,
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
