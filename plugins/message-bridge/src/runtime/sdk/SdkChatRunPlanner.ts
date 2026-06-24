import type {
  ProviderRun,
  ProviderRunMessageInput,
} from '@wecode/bridge-runtime-sdk';
import type {
  BusinessEntryContext,
  BusinessEntryContextResolver,
} from './session-isolation/index.js';
import type {
  ChatExecutionContext,
  ChatExecutionContextResolver,
  ChatMessageClassification,
  ChatRunContext,
  ChatRunContextResolver,
  NormalChatSessionResolver,
  SdkSlashExecutionUseCase,
  SlashCommandClassification,
} from './SdkChatControlPlane.js';
import { buildSyntheticRun } from './SdkChatControlPlane.helpers.js';
import type { BridgeLogger } from '../AppLogger.js';

const GROUP_CHAT_DENY_REPLY_TEXT = '本机器人不处理群聊消息，请勿在群内@提问';

export type ChatQueuedExecution =
  | { kind: 'prompt'; text: string }
  | { kind: 'native_command'; commandName: string; arguments: string };

export type ChatRunPlan =
  | { kind: 'immediate_synthetic'; run: ProviderRun }
  | { kind: 'queued_execution'; context: ChatRunContext; execution: ChatQueuedExecution };

export interface ChatMessageClassifierPort {
  classify(input: {
    message: ProviderRunMessageInput;
    context: ChatRunContext;
    logger?: BridgeLogger;
  }): Promise<ChatMessageClassification>;
}

/**
 * SDK chat run 计划器。
 * @remarks 负责 entry/session context 构建、消息分类和本地 slash synthetic 结果生成，不执行 queued run。
 */
export class SdkChatRunPlanner {
  constructor(private readonly dependencies: {
    chatMessageClassifier: ChatMessageClassifierPort;
    slashExecutionUseCase: SdkSlashExecutionUseCase;
    chatRunContextResolver?: ChatRunContextResolver;
    contextResolver: ChatExecutionContextResolver;
    normalChatSessionResolver?: NormalChatSessionResolver;
    businessEntryContextResolver?: BusinessEntryContextResolver;
    effectiveDirectory?: string;
  }) {}

  async plan(input: ProviderRunMessageInput, logger?: BridgeLogger): Promise<ChatRunPlan> {
    if (input.context?.suppressReply) {
      return this.syntheticRun(input.toolSessionId, GROUP_CHAT_DENY_REPLY_TEXT);
    }

    const context = await this.resolveChatRunContext(input, logger);
    const classification = await this.dependencies.chatMessageClassifier.classify({
      message: input,
      context,
      logger,
    });

    if (classification.kind === 'suppressed_reply') {
      return this.syntheticRun(input.toolSessionId, classification.text);
    }
    if (classification.kind === 'slash') {
      if (classification.slash.kind === 'bridge_local') {
        return this.executeSlash(input, classification.slash, context, logger);
      }
      return {
        kind: 'queued_execution',
        context,
        execution: {
          kind: 'native_command',
          commandName: classification.slash.commandName,
          arguments: classification.slash.arguments,
        },
      };
    }
    return {
      kind: 'queued_execution',
      context,
      execution: {
        kind: 'prompt',
        text: input.text,
      },
    };
  }

  private async resolveChatRunContext(
    input: ProviderRunMessageInput,
    logger: BridgeLogger | undefined,
  ): Promise<ChatRunContext> {
    if (this.dependencies.chatRunContextResolver) {
      return this.dependencies.chatRunContextResolver.resolve({ message: input, logger });
    }
    const entryContext = this.dependencies.businessEntryContextResolver?.resolveForChatMessage(input);
    const context = await this.resolveExecutionContext(input, entryContext, logger);
    return {
      ...context,
      ...(entryContext ? { entryContext } : {}),
      ...(this.dependencies.effectiveDirectory ? { directory: this.dependencies.effectiveDirectory } : {}),
    };
  }

  private async resolveExecutionContext(
    input: ProviderRunMessageInput,
    entryContext: BusinessEntryContext | undefined,
    logger: BridgeLogger | undefined,
  ): Promise<ChatExecutionContext> {
    if (this.dependencies.normalChatSessionResolver) {
      return this.dependencies.normalChatSessionResolver.resolve({
        message: input,
        entryContext,
        ...(this.dependencies.effectiveDirectory ? { directory: this.dependencies.effectiveDirectory } : {}),
        logger,
      });
    }
    return this.dependencies.contextResolver.resolveForChat(
      input.toolSessionId,
      {
        assistantId: input.assistantId,
      },
      logger,
    );
  }

  private logSlashDecision(
    input: ProviderRunMessageInput,
    classification: ChatMessageClassification,
    context: ChatRunContext,
    logger: BridgeLogger | undefined,
  ): void {
    if (classification.kind !== 'slash' || classification.slash.kind !== 'bridge_local') {
      return;
    }
    logger?.info?.('sdk_chat_run_planner.entry_policy_decision', {
      toolSessionId: input.toolSessionId,
      runId: input.runId,
      policySource: context.entryContext?.policy.slashPolicySource ?? 'local_default',
      allowedSlashCommands: context.entryContext?.policy.allowedSlashCommands,
      decisionKind: 'slash',
      commandKind: classification.slash.descriptor.kind,
      disabledInEntry: Boolean(classification.slash.disabledInEntry),
      invalid: Boolean(classification.slash.invalid),
    });
  }

  private async executeSlash(
    input: ProviderRunMessageInput,
    decision: Extract<SlashCommandClassification, { kind: 'bridge_local' }>,
    context: ChatRunContext,
    logger: BridgeLogger | undefined,
  ): Promise<ChatRunPlan> {
    this.logSlashDecision(input, { kind: 'slash', slash: decision }, context, logger);
    return this.syntheticRun(input.toolSessionId, await this.dependencies.slashExecutionUseCase.execute({
      anchor: input.toolSessionId,
      descriptor: decision.descriptor,
      command: decision.command,
      entryContext: context.entryContext,
      disabledInEntry: decision.disabledInEntry,
      invalid: decision.invalid,
      createContext: {
        assistantId: input.assistantId,
      },
      ensuredContext: context,
      ...(context.directory ? { directory: context.directory } : {}),
      logger,
    }));
  }

  private syntheticRun(toolSessionId: string, input: string | ProviderRun): ChatRunPlan {
    return {
      kind: 'immediate_synthetic',
      run: typeof input === 'string' ? buildSyntheticRun(toolSessionId, input) : input,
    };
  }
}
