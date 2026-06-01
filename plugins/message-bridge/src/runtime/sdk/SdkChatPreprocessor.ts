import type {
  ProviderRun,
  ProviderRunMessageInput,
} from '@wecode/bridge-runtime-sdk';
import type {
  BusinessEntryContext,
  BusinessEntryContextResolver,
} from './session-isolation/index.js';
import type {
  ChatEntryPolicy,
  ChatExecutionContext,
  ChatExecutionContextResolver,
  NormalChatSessionResolver,
  SdkSlashExecutionUseCase,
} from './SdkChatControlPlane.js';
import { buildSyntheticRun } from './SdkChatControlPlane.helpers.js';
import type { BridgeLogger } from '../AppLogger.js';

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
    normalChatSessionResolver?: NormalChatSessionResolver;
    businessEntryContextResolver?: BusinessEntryContextResolver;
    effectiveDirectory?: string;
  }) {}

  async preprocess(input: ProviderRunMessageInput, logger?: BridgeLogger): Promise<PreprocessResult> {
    const suppressDecision = this.dependencies.chatEntryPolicy.decide(input);
    if (suppressDecision.kind === 'deny') {
      return this.syntheticRun(input.toolSessionId, suppressDecision.text);
    }

    const entryContext = this.resolveEntryContext(input);
    const ensuredContext = await this.resolveEnsuredContext(input, entryContext, logger);
    const decision = this.dependencies.chatEntryPolicy.decide(input, entryContext?.policy);
    this.logSlashDecision(input, decision, entryContext, logger);

    if (decision.kind === 'deny') {
      return this.syntheticRun(input.toolSessionId, decision.text);
    }
    if (decision.kind === 'slash') {
      return this.executeSlash(input, decision, entryContext, ensuredContext, logger);
    }
    return {
      kind: 'normal_chat',
      context: ensuredContext,
    };
  }

  private resolveEntryContext(input: ProviderRunMessageInput): BusinessEntryContext | undefined {
    return this.dependencies.businessEntryContextResolver?.resolveForChatMessage(input);
  }

  private async resolveEnsuredContext(
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
        imGroupId: input.context?.imGroupId,
      },
      logger,
    );
  }

  private logSlashDecision(
    input: ProviderRunMessageInput,
    decision: ReturnType<ChatEntryPolicy['decide']>,
    entryContext: BusinessEntryContext | undefined,
    logger: BridgeLogger | undefined,
  ): void {
    if (decision.kind !== 'slash') {
      return;
    }
    logger?.info?.('sdk_chat_preprocessor.entry_policy_decision', {
      toolSessionId: input.toolSessionId,
      runId: input.runId,
      policySource: entryContext?.policy.slashPolicySource ?? 'local_default',
      allowedSlashCommands: entryContext?.policy.allowedSlashCommands,
      decisionKind: decision.kind,
      commandKind: decision.descriptor.kind,
      disabledInEntry: Boolean(decision.disabledInEntry),
      invalid: Boolean(decision.invalid),
    });
  }

  private async executeSlash(
    input: ProviderRunMessageInput,
    decision: Extract<ReturnType<ChatEntryPolicy['decide']>, { kind: 'slash' }>,
    entryContext: BusinessEntryContext | undefined,
    ensuredContext: ChatExecutionContext,
    logger: BridgeLogger | undefined,
  ): Promise<PreprocessResult> {
    return this.syntheticRun(input.toolSessionId, await this.dependencies.slashExecutionUseCase.execute({
      anchor: input.toolSessionId,
      descriptor: decision.descriptor,
      command: decision.command,
      entryContext,
      disabledInEntry: decision.disabledInEntry,
      invalid: decision.invalid,
      createContext: {
        assistantId: input.assistantId,
        imGroupId: input.context?.imGroupId,
      },
      ensuredContext,
      ...(this.dependencies.effectiveDirectory ? { directory: this.dependencies.effectiveDirectory } : {}),
      logger,
    }));
  }

  private syntheticRun(toolSessionId: string, input: string | ProviderRun): PreprocessResult {
    return {
      kind: 'synthetic_run',
      run: typeof input === 'string' ? buildSyntheticRun(toolSessionId, input) : input,
    };
  }
}
