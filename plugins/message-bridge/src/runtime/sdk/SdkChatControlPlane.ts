import { randomUUID } from 'node:crypto';

import type {
  MessageDoneFact,
  MessageStartFact,
  ProviderFact,
  ProviderRun,
  ProviderRunMessageInput,
  TextDeltaFact,
  TextDoneFact,
} from '../../../../../packages/bridge-runtime-sdk/src/index.ts';
import type {
  HostModelCatalogPort,
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
  ToolSessionBindingStore,
} from '../../port/SlashCommandControlPlanePort.js';
import { SlashCommandExecutor } from '../../usecase/SlashCommandExecutor.js';
import type { BridgeLogger } from '../AppLogger.js';

const GROUP_CHAT_DENY_REPLY_TEXT = '本机器人不处理群聊消息，请勿在群内@提问';

function fromFacts(facts: ProviderFact[]): AsyncIterable<ProviderFact> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

function buildSyntheticRun(toolSessionId: string, text: string): ProviderRun {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  const partId = `prt_${randomUUID().replaceAll('-', '')}`;
  const facts: ProviderFact[] = [
    {
      type: 'message.start',
      messageId,
    } satisfies MessageStartFact,
    {
      type: 'text.delta',
      messageId,
      partId,
      content: text,
    } satisfies TextDeltaFact,
    {
      type: 'text.done',
      messageId,
      partId,
      content: text,
    } satisfies TextDoneFact,
    {
      type: 'message.done',
      messageId,
      reason: 'stop',
    } satisfies MessageDoneFact,
  ];

  return {
    runId: `synthetic-${toolSessionId}`,
    facts: fromFacts(facts),
    async result() {
      return { outcome: 'completed' };
    },
  };
}

type EntryKind = 'direct_chat' | 'group_chat';

export interface ChatExecutionContext {
  opencodeSessionId: string;
  scope?: SessionScope;
  modelOverride?: SessionModelOverride;
  bootstrapSource: SlashCommandContext['bootstrapSource'];
}

export interface ChatExecutionContextResolver {
  resolveForChat(anchor: string, createContext?: HostSessionCreateContext, logger?: BridgeLogger): Promise<ChatExecutionContext>;
  resolveForControlAction(anchor: string, logger?: BridgeLogger): Promise<{ opencodeSessionId: string }>;
}

export interface ExecutionSessionInvalidationPort {
  invalidateAfterFailure(anchor: string, error: unknown): void;
}

export interface EventAnchorResolver {
  resolveForEvent(opencodeSessionId: string): { anchor: string } | undefined;
}

export interface CreatedSessionBindingPort {
  register(anchor: string, opencodeSessionId: string): void;
}

type EntryPolicyDecision =
  | { kind: 'deny'; text: string }
  | { kind: 'normal_chat' }
  | {
      kind: 'slash';
      descriptor: SlashCommandDescriptor;
      command?: SlashCommand;
      disabledInEntry?: boolean;
      invalid?: boolean;
    };

/**
 * SDK chat 入口的 slash 能力策略。
 */
export class StaticSlashCapabilityProvider {
  isAllowed(input: { entryKind: EntryKind; command: SlashCommandDescriptor }): boolean {
    if (input.entryKind !== 'group_chat') {
      return true;
    }
    return input.command.kind !== 'sessions' && input.command.kind !== 'session';
  }
}

/**
 * SDK chat 入口判定器。
 */
export class ChatEntryPolicy {
  constructor(private readonly dependencies: {
    slashCommandParser: SlashCommandParser;
    slashCapabilityProvider: StaticSlashCapabilityProvider;
  }) {}

  decide(input: ProviderRunMessageInput): EntryPolicyDecision {
    if (input.context?.suppressReply) {
      return { kind: 'deny', text: GROUP_CHAT_DENY_REPLY_TEXT };
    }

    const entryKind = this.resolveEntryKind(input);
    const parseResult = this.dependencies.slashCommandParser.tryParse({
      text: input.text,
      isGroupChat: entryKind === 'group_chat',
    });

    if (parseResult.kind === 'none') {
      return { kind: 'normal_chat' };
    }

    const descriptor = parseResult.kind === 'matched'
      ? { kind: parseResult.command.kind }
      : parseResult.command;

    const allowed = this.dependencies.slashCapabilityProvider.isAllowed({
      entryKind,
      command: descriptor,
    });
    if (!allowed) {
      return {
        kind: 'slash',
        descriptor,
        disabledInEntry: true,
      };
    }

    if (parseResult.kind === 'invalid') {
      return {
        kind: 'slash',
        descriptor,
        invalid: true,
      };
    }

    return {
      kind: 'slash',
      descriptor,
      command: parseResult.command,
    };
  }

  private resolveEntryKind(input: ProviderRunMessageInput): EntryKind {
    return input.context?.imGroupId?.trim() ? 'group_chat' : 'direct_chat';
  }
}

/**
 * slash synthetic run 执行器。
 */
export class SdkSlashExecutionUseCase {
  constructor(private readonly dependencies: {
    slashCommandExecutor: SlashCommandExecutor;
    replyPresenter: SlashCommandReplyPresenter;
    contextResolver: ChatExecutionContextResolver;
  }) {}

  async execute(input: {
    anchor: string;
    descriptor: SlashCommandDescriptor;
    command?: SlashCommand;
    createContext?: HostSessionCreateContext;
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
      const context = await this.dependencies.contextResolver.resolveForChat(
        input.anchor,
        input.createContext,
        input.logger,
      );
      const commandContext: SlashCommandContext = {
        anchor: input.anchor,
        activeOpencodeSessionId: context.opencodeSessionId,
        scope: context.scope,
        modelOverride: context.modelOverride,
        bootstrapSource: context.bootstrapSource,
      };
      const result = await this.dependencies.slashCommandExecutor.execute(
        input.command,
        commandContext,
        input.createContext,
      );
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
      this.rebind(anchor, undefined, recentSession.id);
      logger?.info('sdk_chat_context.bootstrap_reused_recent_session', {
        anchor,
        opencodeSessionId: recentSession.id,
      });
      return {
        opencodeSessionId: recentSession.id,
        scope: this.buildScope(recentSession),
        modelOverride: this.dependencies.modelOverrideStore.get(recentSession.id),
        bootstrapSource: 'bootstrap_reused_recent_session',
      };
    }

    const created = await this.dependencies.hostSessionCreationPort.createSession(createContext);
    this.rebind(anchor, undefined, created.id);
    logger?.info('sdk_chat_context.bootstrap_created', {
      anchor,
      opencodeSessionId: created.id,
    });
    return {
      opencodeSessionId: created.id,
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
      return {
        opencodeSessionId: existing.activeOpencodeSessionId,
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

  private rebind(anchor: string, previousSessionId: string | undefined, nextSessionId: string): void {
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

  invalidateAfterFailure(anchor: string, error: unknown): void {
    const evidence = this.extractEvidence(error);
    if (evidence.sourceErrorCode !== 'session_not_found') {
      return;
    }
    if (evidence.sourceOperation !== 'session.get' && evidence.sourceOperation !== 'session.prompt') {
      return;
    }
    const binding = this.dependencies.bindingStore.get(anchor);
    if (!binding) {
      return;
    }
    this.dependencies.bindingStore.invalidate(anchor);
    this.dependencies.ownershipResolver.detach(binding.activeOpencodeSessionId);
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

/**
 * create_session 后建立 anchor 到 active session 的绑定。
 */
export class DefaultCreatedSessionBindingPort implements CreatedSessionBindingPort {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
  }) {}

  register(anchor: string, opencodeSessionId: string): void {
    this.dependencies.bindingStore.bind(anchor, opencodeSessionId);
    this.dependencies.ownershipResolver.attach(opencodeSessionId, anchor);
  }
}

type PreprocessResult =
  | { kind: 'synthetic_run'; run: ProviderRun }
  | { kind: 'normal_chat'; context: ChatExecutionContext };

/**
 * SDK chat 入口预处理编排器。
 */
export class SdkChatPreprocessor {
  constructor(private readonly dependencies: {
    chatEntryPolicy: ChatEntryPolicy;
    slashExecutionUseCase: SdkSlashExecutionUseCase;
    contextResolver: ChatExecutionContextResolver;
  }) {}

  async preprocess(input: ProviderRunMessageInput, logger?: BridgeLogger): Promise<PreprocessResult> {
    const decision = this.dependencies.chatEntryPolicy.decide(input);
    if (decision.kind === 'deny') {
      return {
        kind: 'synthetic_run',
        run: buildSyntheticRun(input.toolSessionId, decision.text),
      };
    }

    if (decision.kind === 'slash') {
      return {
        kind: 'synthetic_run',
        run: await this.dependencies.slashExecutionUseCase.execute({
          anchor: input.toolSessionId,
          descriptor: decision.descriptor,
          command: decision.command,
          disabledInEntry: decision.disabledInEntry,
          invalid: decision.invalid,
          createContext: {
            assistantId: input.assistantId,
            imGroupId: input.context?.imGroupId,
          },
          logger,
        }),
      };
    }

    return {
      kind: 'normal_chat',
      context: await this.dependencies.contextResolver.resolveForChat(
        input.toolSessionId,
        {
          assistantId: input.assistantId,
          imGroupId: input.context?.imGroupId,
        },
        logger,
      ),
    };
  }
}
