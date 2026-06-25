import type {
  ProviderRun,
  ProviderRunMessageInput,
} from '@wecode/bridge-runtime-sdk';
import type {
  BusinessEntryContextResolver,
} from './session-isolation/index.js';
import type {
  ChatActionContext,
  ChatMessageClassification,
  ChatMessageClassifierPort,
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
  | { kind: 'queued_execution'; context: ChatActionContext; execution: ChatQueuedExecution };

/**
 * SDK chat run 计划器。
 * @remarks 负责 entry/session context 构建、消息分类和本地 slash synthetic 结果生成，不执行 queued run。
 */
export class SdkChatRunPlanner {
  constructor(private readonly dependencies: {
    chatMessageClassifier: ChatMessageClassifierPort;
    slashExecutionUseCase: SdkSlashExecutionUseCase;
    normalChatSessionResolver: NormalChatSessionResolver;
    businessEntryContextResolver: BusinessEntryContextResolver;
    effectiveDirectory?: string;
  }) {
    if (!dependencies.normalChatSessionResolver) {
      throw new Error('entry_aware_chat_session_resolver_required');
    }
  }

  async plan(input: ProviderRunMessageInput, logger?: BridgeLogger): Promise<ChatRunPlan> {
    if (input.context?.suppressReply) {
      return this.syntheticRun(input.toolSessionId, GROUP_CHAT_DENY_REPLY_TEXT);
    }

    const context = await this.resolveChatActionContext(input, logger);
    const classification = await this.dependencies.chatMessageClassifier.classify({
      context,
    });

    if (classification.kind === 'slash') {
      if (classification.slash.kind === 'bridge_local') {
        return this.executeSlash(classification.slash, context);
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

  private async resolveChatActionContext(
    input: ProviderRunMessageInput,
    logger: BridgeLogger | undefined,
  ): Promise<ChatActionContext> {
    const entryContext = this.dependencies.businessEntryContextResolver.resolveForChatMessage(input);
    const sessionContext = await this.dependencies.normalChatSessionResolver.resolve({
      message: input,
      entryContext,
      ...(this.dependencies.effectiveDirectory ? { directory: this.dependencies.effectiveDirectory } : {}),
      logger,
    });
    return {
      message: input,
      anchor: input.toolSessionId,
      entryContext,
      sessionContext,
      ...(this.dependencies.effectiveDirectory ? { effectiveDirectory: this.dependencies.effectiveDirectory } : {}),
      ...(logger ? { logger } : {}),
    };
  }

  private logSlashDecision(
    classification: ChatMessageClassification,
    context: ChatActionContext,
  ): void {
    if (classification.kind !== 'slash' || classification.slash.kind !== 'bridge_local') {
      return;
    }
    context.logger?.info?.('sdk_chat_run_planner.entry_policy_decision', {
      toolSessionId: context.anchor,
      runId: context.message.runId,
      policySource: context.entryContext.policy.slashPolicySource ?? 'local_default',
      allowedSlashCommands: context.entryContext.policy.allowedSlashCommands,
      decisionKind: 'slash',
      commandKind: classification.slash.descriptor.kind,
      disabledInEntry: Boolean(classification.slash.disabledInEntry),
      invalid: Boolean(classification.slash.invalid),
    });
  }

  private async executeSlash(
    decision: Extract<SlashCommandClassification, { kind: 'bridge_local' }>,
    context: ChatActionContext,
  ): Promise<ChatRunPlan> {
    this.logSlashDecision({ kind: 'slash', slash: decision }, context);
    return this.syntheticRun(context.anchor, await this.dependencies.slashExecutionUseCase.execute({
      context,
      slash: decision,
    }));
  }

  private syntheticRun(toolSessionId: string, input: string | ProviderRun): ChatRunPlan {
    return {
      kind: 'immediate_synthetic',
      run: typeof input === 'string' ? buildSyntheticRun(toolSessionId, input) : input,
    };
  }
}
