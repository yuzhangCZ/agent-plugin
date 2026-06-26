import type {
  ProviderRun,
  ProviderRunMessageInput,
} from '@wecode/bridge-runtime-sdk';
import type {
  BusinessEntryContext,
} from './session-isolation/index.js';

import type {
  HostSessionCreateContext,
  HostSessionCreationPort,
  HostSessionQueryPort,
  OpencodeSessionOwnershipResolver,
  SessionScope,
  SessionModelOverride,
  SessionModelOverrideStore,
  SlashCommandContext,
  SlashCommandFailure,
  SlashCommandFailureCode,
  SlashCommandReplyPresenter,
  ToolSessionBindingStore,
} from '../../port/SlashCommandControlPlanePort.js';
import type { BridgeLogger } from '../AppLogger.js';
import { buildSyntheticRun } from './SdkChatControlPlane.helpers.js';
import type {
  SlashCommandClassification,
} from './ChatMessageClassifier.js';
import type { SdkChatSlashCommandExecutor } from './SdkChatSlashCommandExecutor.js';
export {
  ChatMessageClassifier,
  type ChatMessageClassification,
  type ChatMessageClassifierPort,
  type OpenCodeNativeCommandCatalog,
  type OpenCodeNativeCommandDescriptor,
  type SlashCapabilityProvider,
  type SlashCommandClassification,
} from './ChatMessageClassifier.js';
export {
  SdkChatRunPlanner,
  type ChatQueuedExecution,
  type ChatRunPlan,
} from './SdkChatRunPlanner.js';

export interface ChatExecutionContext {
  opencodeSessionId: string;
  session?: {
    id: string;
    title?: string;
    projectID?: string;
    workspaceID?: string;
    directory?: string;
  };
  scope?: SessionScope;
  modelOverride?: SessionModelOverride;
  bootstrapSource: SlashCommandContext['bootstrapSource'];
}

/**
 * 一次 SDK chat action 的完整运行上下文。
 * @remarks `sessionContext` 只描述已解析的 OpenCode 宿主会话；
 * `effectiveDirectory` 是本次 action 的工作目录约束，不从宿主会话目录推导。
 */
export interface ChatActionContext {
  message: ProviderRunMessageInput;
  anchor: string;
  entryContext: BusinessEntryContext;
  sessionContext: ChatExecutionContext;
  effectiveDirectory?: string;
  logger?: BridgeLogger;
}

export interface ChatExecutionContextResolver {
  resolveForChat(anchor: string, createContext?: HostSessionCreateContext, logger?: BridgeLogger): Promise<ChatExecutionContext>;
  resolveForControlAction(anchor: string, logger?: BridgeLogger): Promise<{ opencodeSessionId: string }>;
}

export interface ExecutionSessionInvalidationPort {
  invalidateAfterFailure(input: {
    conversationId: string;
    hostSessionId: string;
    error: unknown;
  }): void;
}

export interface EventAnchorResolver {
  resolveForEvent(opencodeSessionId: string): { anchor: string } | undefined;
}

export interface SessionAttachmentPort {
  switchAttachedSession(input: { toolSessionId: string; sessionId: string }): Promise<{ applied: boolean }>;
}

export interface NormalChatSessionResolver {
  resolve(input: {
    message: ProviderRunMessageInput;
    entryContext: BusinessEntryContext;
    directory?: string;
    logger?: BridgeLogger;
  }): Promise<ChatExecutionContext>;
}

type SdkSlashExecutionUseCaseInputBase = {
  context: ChatActionContext;
};

type SdkSlashExecutionUseCaseInput = SdkSlashExecutionUseCaseInputBase & {
  slash: Extract<SlashCommandClassification, { kind: 'bridge_local' }>;
};

/**
 * bridge-local slash synthetic run 执行器。
 * @remarks 仅处理插件本地实现的 slash command，例如 /new、/sessions、/session、/models、/model。
 * OpenCode native slash command 在 `SdkChatRunPlanner` 中转为 queued native_command，
 * 后续由 provider adapter 调用 OpenCode `session.command` 执行。
 */
export class SdkSlashExecutionUseCase {
  constructor(private readonly dependencies: {
    slashCommandExecutor: SdkChatSlashCommandExecutor;
    replyPresenter: SlashCommandReplyPresenter;
  }) {}

  async execute(input: SdkSlashExecutionUseCaseInput): Promise<ProviderRun> {
    if (input.slash.disabledInEntry) {
      return buildSyntheticRun(
        input.context.anchor,
        this.dependencies.replyPresenter.presentFailure(input.slash.descriptor, {
          code: 'command_disabled_in_group_chat',
          reasonKey: 'command_not_available_in_group_chat',
        }),
      );
    }

    if (input.slash.invalid || !input.slash.command) {
      return buildSyntheticRun(
        input.context.anchor,
        this.dependencies.replyPresenter.presentFailure(input.slash.descriptor, {
          code: 'invalid_command',
        }),
      );
    }

    try {
      const result = await this.dependencies.slashCommandExecutor.execute({
        command: input.slash.command,
        context: input.context,
      });
      return buildSyntheticRun(input.context.anchor, this.dependencies.replyPresenter.presentSuccess(result));
    } catch (error) {
      return buildSyntheticRun(
        input.context.anchor,
        this.dependencies.replyPresenter.presentFailure(
          input.slash.descriptor,
          this.normalizeFailure(error),
        ),
      );
    }
  }

  private normalizeFailure(error: unknown): SlashCommandFailure {
    const sourceErrorCode = this.extractSourceErrorCode(error);
    if (sourceErrorCode === 'session_not_found') {
      return { code: 'session_not_found' as const };
    }

    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && typeof (error as { code: unknown }).code === 'string'
    ) {
      const normalizedError = error as {
        code: string;
        reasonKey?: unknown;
      };
      const reasonKey = this.isSlashCommandFailureReasonKey(normalizedError.reasonKey)
        ? normalizedError.reasonKey
        : undefined;
      return {
        code: this.isSlashCommandFailureCode(normalizedError.code) ? normalizedError.code : 'sdk_unreachable',
        ...(reasonKey ? { reasonKey } : {}),
      };
    }

    return { code: 'sdk_unreachable' as const };
  }

  private extractSourceErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }
    const evidence = (error as {
      errorEvidence?: { sourceErrorCode?: unknown };
    }).errorEvidence;
    return typeof evidence?.sourceErrorCode === 'string' ? evidence.sourceErrorCode : undefined;
  }

  private isSlashCommandFailureCode(code: string): code is SlashCommandFailureCode {
    return code === 'session_not_found'
      || code === 'session_out_of_scope'
      || code === 'model_not_found'
      || code === 'invalid_command'
      || code === 'command_disabled_in_group_chat'
      || code === 'sdk_unreachable';
  }

  private isSlashCommandFailureReasonKey(reasonKey: unknown): reasonKey is SlashCommandFailure['reasonKey'] {
    return reasonKey === 'current_session_unavailable'
      || reasonKey === 'target_session_out_of_scope'
      || reasonKey === 'target_model_unavailable'
      || reasonKey === 'unsupported_command'
      || reasonKey === 'command_not_available_in_group_chat'
      || reasonKey === 'host_unavailable';
  }
}

/**
 * anchor 到 active OpenCode session 的解析器。
 */
export class DefaultChatExecutionContextResolver implements ChatExecutionContextResolver {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
    modelOverrideStore: SessionModelOverrideStore;
    hostSessionCreationPort: HostSessionCreationPort;
    hostSessionQueryPort: HostSessionQueryPort;
    sessionAttachmentPort?: SessionAttachmentPort;
  }) {}

  async resolveForChat(
    anchor: string,
    createContext?: HostSessionCreateContext,
    logger?: BridgeLogger,
  ): Promise<ChatExecutionContext> {
    const bound = await this.resolveActiveBinding(anchor, logger);
    if (bound) {
      return bound;
    }

    const recentSessions = await this.dependencies.hostSessionQueryPort.listSessions({});
    const recentSession = recentSessions[0];
    if (recentSession) {
      await this.rebind(anchor, undefined, recentSession.id);
      logger?.info('sdk_chat_context.bootstrap_reused_recent_session', {
        anchor,
        opencodeSessionId: recentSession.id,
      });
      return {
        opencodeSessionId: recentSession.id,
        session: recentSession,
        scope: this.buildScope(recentSession),
        modelOverride: this.dependencies.modelOverrideStore.get(recentSession.id),
        bootstrapSource: 'bootstrap_reused_recent_session',
      };
    }

    const created = await this.dependencies.hostSessionCreationPort.createSession(createContext);
    await this.rebind(anchor, undefined, created.id);
    logger?.info('sdk_chat_context.bootstrap_created', {
      anchor,
      opencodeSessionId: created.id,
    });
    return {
      opencodeSessionId: created.id,
      session: created,
      scope: this.buildScope(created),
      bootstrapSource: 'bootstrap_created',
    };
  }

  async resolveForControlAction(anchor: string, logger?: BridgeLogger): Promise<{ opencodeSessionId: string }> {
    const existing = this.dependencies.bindingStore.get(anchor);
    if (!existing || existing.status !== 'active') {
      const notFoundError = new Error('session_not_found');
      Object.assign(notFoundError, { errorEvidence: { sourceOperation: 'session.get', sourceErrorCode: 'session_not_found' } });
      throw notFoundError;
    }
    try {
      await this.dependencies.hostSessionQueryPort.getSession(existing.activeOpencodeSessionId);
      return { opencodeSessionId: existing.activeOpencodeSessionId };
    } catch (error) {
      if (this.shouldInvalidateBinding(error)) {
        this.dependencies.bindingStore.invalidate(anchor);
        this.dependencies.ownershipResolver.detach(existing.activeOpencodeSessionId);
      }
      logger?.warn('sdk_chat_context.control_action_resolve_failed', {
        anchor,
        opencodeSessionId: existing.activeOpencodeSessionId,
      });
      const notFoundError = new Error('session_not_found');
      Object.assign(notFoundError, { errorEvidence: { sourceOperation: 'session.get', sourceErrorCode: 'session_not_found' } });
      throw notFoundError;
    }
  }

  private async resolveActiveBinding(anchor: string, logger?: BridgeLogger): Promise<ChatExecutionContext | undefined> {
    const existing = this.dependencies.bindingStore.get(anchor);
    if (!existing || existing.status !== 'active') {
      return undefined;
    }

    try {
      const session = await this.dependencies.hostSessionQueryPort.getSession(existing.activeOpencodeSessionId);
      // 普通 chat 命中已有 binding 也代表该 anchor 最近使用了此 host session；
      // TUI detached outbound run 会依赖 attached owner 选择回流目标。
      await this.refreshAttachedOwner(anchor, existing.activeOpencodeSessionId);
      return {
        opencodeSessionId: existing.activeOpencodeSessionId,
        session,
        scope: this.buildScope(session),
        modelOverride: this.dependencies.modelOverrideStore.get(existing.activeOpencodeSessionId),
        bootstrapSource: 'existing_binding',
      };
    } catch (error) {
      if (!this.shouldInvalidateBinding(error)) {
        throw error;
      }
      this.dependencies.bindingStore.invalidate(anchor);
      this.dependencies.ownershipResolver.detach(existing.activeOpencodeSessionId);
      logger?.warn('sdk_chat_context.binding_invalidated', {
        anchor,
        opencodeSessionId: existing.activeOpencodeSessionId,
      });
      return undefined;
    }
  }

  private async refreshAttachedOwner(anchor: string, sessionId: string): Promise<void> {
    if (this.dependencies.sessionAttachmentPort) {
      await this.dependencies.sessionAttachmentPort.switchAttachedSession({
        toolSessionId: anchor,
        sessionId,
      });
      return;
    }
    this.dependencies.ownershipResolver.attach(sessionId, anchor);
  }

  private async rebind(anchor: string, previousSessionId: string | undefined, nextSessionId: string): Promise<void> {
    if (this.dependencies.sessionAttachmentPort) {
      await this.dependencies.sessionAttachmentPort.switchAttachedSession({
        toolSessionId: anchor,
        sessionId: nextSessionId,
      });
      return;
    }
    if (previousSessionId && previousSessionId !== nextSessionId) {
      this.dependencies.ownershipResolver.detach(previousSessionId);
    }
    this.dependencies.bindingStore.bind(anchor, nextSessionId);
    this.dependencies.ownershipResolver.attach(nextSessionId, anchor);
  }

  private buildScope(session: {
    projectID?: string;
    workspaceID?: string;
    directory?: string;
  }): SessionScope | undefined {
    const scope = {
      ...(session.projectID ? { projectID: session.projectID } : {}),
      ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
      ...(session.directory ? { directory: session.directory } : {}),
    };
    return Object.keys(scope).length > 0 ? scope : undefined;
  }

  private shouldInvalidateBinding(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const evidence = (error as {
      errorEvidence?: { sourceOperation?: unknown; sourceErrorCode?: unknown };
    }).errorEvidence;
    return evidence?.sourceOperation === 'session.get' && evidence?.sourceErrorCode === 'session_not_found';
  }
}

/**
 * stale binding 失效回写端口。
 */
export class DefaultExecutionSessionInvalidationPort implements ExecutionSessionInvalidationPort {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
  }) {}

  invalidateAfterFailure(input: {
    conversationId: string;
    hostSessionId: string;
    error: unknown;
  }): void {
    const evidence = this.extractEvidence(input.error);
    if (evidence.sourceErrorCode !== 'session_not_found') {
      return;
    }
    if (evidence.sourceOperation !== 'session.get' && evidence.sourceOperation !== 'session.prompt') {
      return;
    }
    const binding = this.dependencies.bindingStore.get(input.conversationId);
    if (!binding || binding.activeOpencodeSessionId !== input.hostSessionId) {
      return;
    }
    this.dependencies.bindingStore.invalidate(input.conversationId);
    this.dependencies.ownershipResolver.detach(input.hostSessionId);
  }

  private extractEvidence(error: unknown): { sourceOperation?: string; sourceErrorCode?: string } {
    if (typeof error !== 'object' || error === null) {
      return {};
    }
    const evidence = (error as {
      errorEvidence?: { sourceOperation?: unknown; sourceErrorCode?: unknown };
    }).errorEvidence;
    return {
      ...(typeof evidence?.sourceOperation === 'string' ? { sourceOperation: evidence.sourceOperation } : {}),
      ...(typeof evidence?.sourceErrorCode === 'string' ? { sourceErrorCode: evidence.sourceErrorCode } : {}),
    };
  }
}

/**
 * event 归属解析器。
 */
export class DefaultEventAnchorResolver implements EventAnchorResolver {
  constructor(private readonly dependencies: {
    ownershipResolver: OpencodeSessionOwnershipResolver;
  }) {}

  resolveForEvent(opencodeSessionId: string): { anchor: string } | undefined {
    const anchor = this.dependencies.ownershipResolver.resolveAttachedAnchor(opencodeSessionId);
    return anchor ? { anchor } : undefined;
  }
}
