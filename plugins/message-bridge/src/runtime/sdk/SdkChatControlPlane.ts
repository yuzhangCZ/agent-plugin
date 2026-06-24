import type {
  ProviderRun,
  ProviderRunMessageInput,
} from '@wecode/bridge-runtime-sdk';
import type {
  BusinessEntryContext,
} from './session-isolation/index.js';
import type { BusinessEntryPolicy } from '../../port/session-isolation/dto/commands/index.js';

import type {
  HostSessionCreateContext,
  HostSessionCreationPort,
  HostSessionQueryPort,
  OpencodeSessionOwnershipResolver,
  SessionScope,
  SessionModelOverride,
  SessionModelOverrideStore,
  SlashCommand,
  SlashCommandContext,
  SlashCommandDescriptor,
  SlashCommandParser,
  SlashCommandReplyPresenter,
  SlashCommandResult,
  ToolSessionBindingStore,
} from '../../port/SlashCommandControlPlanePort.js';
import type { SlashCommandExecutor } from '../../usecase/SlashCommandExecutor.js';
import type { BridgeLogger } from '../AppLogger.js';
import { buildSyntheticRun } from './SdkChatControlPlane.helpers.js';
import {
  SlashCommandExecutionRouter,
  type SlashCommandExecutionRouterPort,
} from './SdkSlashCommandExecutionRouter.js';
export {
  SdkChatRunPlanner,
  type ChatQueuedExecution,
  type ChatRunPlan,
} from './SdkChatRunPlanner.js';

const GROUP_CHAT_DENY_REPLY_TEXT = '本机器人不处理群聊消息，请勿在群内@提问';

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

export interface ChatRunContext extends ChatExecutionContext {
  entryContext?: BusinessEntryContext;
  directory?: string;
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

export interface SessionIsolationSlashCommandExecutionPort {
  execute(input: {
    command: SlashCommand;
    anchor: string;
    ensuredContext: ChatExecutionContext;
    entryContext: BusinessEntryContext;
    createContext?: HostSessionCreateContext;
    directory?: string;
  }): Promise<SlashCommandResult>;
}

export interface NormalChatSessionResolver {
  resolve(input: {
    message: ProviderRunMessageInput;
    entryContext?: BusinessEntryContext;
    directory?: string;
    logger?: BridgeLogger;
  }): Promise<ChatExecutionContext>;
}

export interface ChatRunContextResolver {
  resolve(input: {
    message: ProviderRunMessageInput;
    logger?: BridgeLogger;
  }): Promise<ChatRunContext>;
}

export interface OpenCodeNativeCommandDescriptor {
  name: string;
}

export type OpenCodeNativeCommandListResult =
  | { success: true; commands: OpenCodeNativeCommandDescriptor[] }
  | { success: false; reason: string };

export interface OpenCodeNativeCommandCatalog {
  listCommands(input: { directory?: string }): Promise<OpenCodeNativeCommandListResult>;
}

export type BridgeLocalSlashClassification =
  | {
      kind: 'bridge_local';
      descriptor: SlashCommandDescriptor;
      command?: SlashCommand;
      disabledInEntry?: boolean;
      invalid?: boolean;
    }
  | { kind: 'none'; normalizedText: string };

export type OpenCodeNativeSlashClassification =
  | {
      kind: 'opencode_native';
      commandName: string;
      arguments: string;
    }
  | { kind: 'normal_chat'; fallbackReason?: string; commandName?: string };

export type SlashCommandClassification =
  | Exclude<BridgeLocalSlashClassification, { kind: 'none' }>
  | Extract<OpenCodeNativeSlashClassification, { kind: 'opencode_native' }>;

export type ChatMessageClassification =
  | { kind: 'suppressed_reply'; text: string }
  | { kind: 'slash'; slash: SlashCommandClassification }
  | { kind: 'normal_chat'; fallbackReason?: string; commandName?: string };

/**
 * SDK chat 入口的 slash 能力策略。
 */
export class StaticSlashCapabilityProvider {
  isAllowed(input: { policy?: BusinessEntryPolicy; command: SlashCommandDescriptor }): boolean {
    if (!input.policy) {
      return true;
    }
    return input.policy.allowedSlashCommands.includes(input.command.kind);
  }
}

/**
 * bridge-local slash 分类器。
 * @remarks 只识别插件本地控制命令，并应用本地 `BusinessEntryPolicy` allow-list。
 */
export class BridgeLocalSlashClassifier {
  constructor(private readonly dependencies: {
    slashCommandParser: SlashCommandParser;
    slashCapabilityProvider: StaticSlashCapabilityProvider;
  }) {}

  classify(input: {
    text: string;
    entryContext?: BusinessEntryContext;
  }): BridgeLocalSlashClassification {
    const normalizedText = normalizeSlashText(input.text, input.entryContext);
    const parseResult = this.dependencies.slashCommandParser.tryParse({
      text: normalizedText,
      isGroupChat: isImGroupEntry(input.entryContext),
    });

    if (parseResult.kind === 'none') {
      return { kind: 'none', normalizedText };
    }

    const descriptor = parseResult.kind === 'matched'
      ? { kind: parseResult.command.kind }
      : parseResult.command;

    const allowed = this.dependencies.slashCapabilityProvider.isAllowed({
      policy: input.entryContext?.policy,
      command: descriptor,
    });
    if (!allowed) {
      return {
        kind: 'bridge_local',
        descriptor,
        disabledInEntry: true,
      };
    }

    if (parseResult.kind === 'invalid') {
      return {
        kind: 'bridge_local',
        descriptor,
        invalid: true,
      };
    }

    return {
      kind: 'bridge_local',
      descriptor,
      command: parseResult.command,
    };
  }
}

/**
 * OpenCode native slash 分类器。
 * @remarks 只处理 bridge-local 未命中的 unknown slash，并通过 `command.list` 做 preflight。
 */
export class OpenCodeNativeSlashClassifier {
  constructor(private readonly dependencies: {
    nativeCommandCatalog?: OpenCodeNativeCommandCatalog;
  } = {}) {}

  async classify(input: {
    text: string;
    directory?: string;
  }): Promise<OpenCodeNativeSlashClassification> {
    const nativeCommand = parseNativeSlash(input.text);
    if (!nativeCommand) {
      return { kind: 'normal_chat' };
    }

    if (!this.dependencies.nativeCommandCatalog) {
      return {
        kind: 'normal_chat',
        fallbackReason: 'session.command_unavailable',
        commandName: nativeCommand.commandName,
      };
    }

    const listResult = await this.dependencies.nativeCommandCatalog.listCommands({
      ...(input.directory ? { directory: input.directory } : {}),
    });
    if (!listResult.success) {
      return {
        kind: 'normal_chat',
        fallbackReason: listResult.reason,
        commandName: nativeCommand.commandName,
      };
    }

    if (!listResult.commands.some((command) => command.name === nativeCommand.commandName)) {
      return {
        kind: 'normal_chat',
        fallbackReason: 'command_not_found',
        commandName: nativeCommand.commandName,
      };
    }

    return {
      kind: 'opencode_native',
      commandName: nativeCommand.commandName,
      arguments: nativeCommand.arguments ?? '',
    };
  }
}

/**
 * chat message 分类器。
 * @remarks 基于已构建的 entry/session 上下文分类消息，不执行 slash、prompt 或 command。
 */
export class ChatMessageClassifier {
  constructor(private readonly dependencies: {
    bridgeLocalSlashClassifier: BridgeLocalSlashClassifier;
    openCodeNativeSlashClassifier: OpenCodeNativeSlashClassifier;
  }) {}

  async classify(input: {
    message: ProviderRunMessageInput;
    context: ChatRunContext;
    logger?: BridgeLogger;
  }): Promise<ChatMessageClassification> {
    if (input.message.context?.suppressReply) {
      return { kind: 'suppressed_reply', text: GROUP_CHAT_DENY_REPLY_TEXT };
    }

    const local = this.dependencies.bridgeLocalSlashClassifier.classify({
      text: input.message.text,
      entryContext: input.context.entryContext,
    });
    if (local.kind === 'bridge_local') {
      return { kind: 'slash', slash: local };
    }

    const native = await this.dependencies.openCodeNativeSlashClassifier.classify({
      text: local.normalizedText,
      ...(input.context.directory ? { directory: input.context.directory } : {}),
    });
    if (native.kind === 'opencode_native') {
      return { kind: 'slash', slash: native };
    }

    if (native.fallbackReason && native.commandName) {
      input.logger?.info?.('sdk_chat_classifier.native_command_preflight_fallback', {
        toolSessionId: input.message.toolSessionId,
        runId: input.message.runId,
        commandName: native.commandName,
        reason: native.fallbackReason,
      });
    }
    return native;
  }
}

function normalizeSlashText(text: string, entryContext: BusinessEntryContext | undefined): string {
  const normalized = text.trim();
  if (!isImGroupEntry(entryContext)) {
    return normalized;
  }
  return normalized.replace(/^@\S+\s+/, '').trim();
}

function parseNativeSlash(text: string): { commandName: string; arguments?: string } | undefined {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return undefined;
  }
  const commandName = match[1]?.trim();
  if (!commandName) {
    return undefined;
  }
  const args = match[2]?.trim();
  return {
    commandName,
    ...(args ? { arguments: args } : {}),
  };
}

function isImGroupEntry(entryContext: BusinessEntryContext | undefined): boolean {
  const entryKey = entryContext?.entryKey;
  return entryKey?.businessSessionDomain.toLowerCase() === 'im'
    && entryKey.businessSessionType.toLowerCase() === 'group';
}

/**
 * slash synthetic run 执行器。
 */
export class SdkSlashExecutionUseCase {
  private readonly slashCommandExecutionRouter: SlashCommandExecutionRouterPort;

  constructor(private readonly dependencies: {
    slashCommandExecutor: SlashCommandExecutor;
    sessionIsolationSlashCommandExecutor?: SessionIsolationSlashCommandExecutionPort;
    replyPresenter: SlashCommandReplyPresenter;
    contextResolver: ChatExecutionContextResolver;
    slashCommandExecutionRouter?: SlashCommandExecutionRouterPort;
  }) {
    this.slashCommandExecutionRouter = dependencies.slashCommandExecutionRouter ?? new SlashCommandExecutionRouter({
      slashCommandExecutor: dependencies.slashCommandExecutor,
      ...(dependencies.sessionIsolationSlashCommandExecutor
        ? { sessionIsolationSlashCommandExecutor: dependencies.sessionIsolationSlashCommandExecutor }
        : {}),
      contextResolver: dependencies.contextResolver,
    });
  }

  async execute(input: {
    anchor: string;
    descriptor: SlashCommandDescriptor;
    command?: SlashCommand;
    entryContext?: BusinessEntryContext;
    createContext?: HostSessionCreateContext;
    directory?: string;
    ensuredContext?: ChatExecutionContext;
    disabledInEntry?: boolean;
    invalid?: boolean;
    logger?: BridgeLogger;
  }): Promise<ProviderRun> {
    if (input.disabledInEntry) {
      return buildSyntheticRun(
        input.anchor,
        this.dependencies.replyPresenter.presentFailure(input.descriptor, {
          code: 'command_disabled_in_group_chat',
          reasonKey: 'command_not_available_in_group_chat',
        }),
      );
    }

    if (input.invalid || !input.command) {
      return buildSyntheticRun(
        input.anchor,
        this.dependencies.replyPresenter.presentFailure(input.descriptor, {
          code: 'invalid_command',
        }),
      );
    }

    try {
      const result = await this.slashCommandExecutionRouter.execute({
        anchor: input.anchor,
        command: input.command,
        ...(input.entryContext ? { entryContext: input.entryContext } : {}),
        ...(input.createContext ? { createContext: input.createContext } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        ...(input.ensuredContext ? { ensuredContext: input.ensuredContext } : {}),
        ...(input.logger ? { logger: input.logger } : {}),
      });
      return buildSyntheticRun(input.anchor, this.dependencies.replyPresenter.presentSuccess(result));
    } catch (error) {
      return buildSyntheticRun(
        input.anchor,
        this.dependencies.replyPresenter.presentFailure(
          input.descriptor,
          this.dependencies.slashCommandExecutor.normalizeFailure(error),
        ),
      );
    }
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
