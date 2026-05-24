import type {
  HostModelCatalogPort,
  HostSessionCreationPort,
  HostSessionCreateContext,
  HostSessionQueryPort,
  SlashCommandFailureDeliveryFailureStage,
  SlashCommandFailureDeliveryResult,
  SlashCommandSuccessDeliveryFailureStage,
  SlashCommandSuccessDeliveryResult,
  SessionModelOverrideStore,
  SlashCommand,
  SlashCommandDescriptor,
  SlashCommandCompletionPort,
  SlashCommandContext,
  SlashCommandFailure,
  SlashCommandFailureCode,
  SlashCommandReplyPresenter,
  ToolSessionBindingStore,
  OpencodeSessionOwnershipResolver,
} from '../port/SlashCommandControlPlanePort.js';
import type { BridgeLogger } from '../types/logger.js';
import { SlashCommandExecutor } from './SlashCommandExecutor.js';

/** 控制面 orchestrator：统一处理 slash 命令、副作用与完成态。 */
export class DefaultSlashCommandOrchestrator {
  private readonly slashCommandExecutor: SlashCommandExecutor;

  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
    modelOverrideStore: SessionModelOverrideStore;
    hostSessionCreationPort: HostSessionCreationPort;
    hostSessionQueryPort: HostSessionQueryPort;
    hostModelCatalogPort: HostModelCatalogPort;
    replyPresenter: SlashCommandReplyPresenter;
    completionPort: SlashCommandCompletionPort;
  }) {
    this.slashCommandExecutor = new SlashCommandExecutor({
      bindingStore: dependencies.bindingStore,
      ownershipResolver: dependencies.ownershipResolver,
      modelOverrideStore: dependencies.modelOverrideStore,
      hostSessionCreationPort: dependencies.hostSessionCreationPort,
      hostSessionQueryPort: dependencies.hostSessionQueryPort,
      hostModelCatalogPort: dependencies.hostModelCatalogPort,
    });
  }

  async execute(input: {
    command: SlashCommand;
    context: SlashCommandContext;
    welinkSessionId?: string;
    createContext?: HostSessionCreateContext;
    logger?: BridgeLogger;
  }): Promise<void> {
    try {
      const result = await this.slashCommandExecutor.execute(input.command, input.context, input.createContext);
      const text = this.dependencies.replyPresenter.presentSuccess(result);
      const deliveryResult = await this.dependencies.completionPort.completeSuccess({
        anchor: input.context.anchor,
        welinkSessionId: input.welinkSessionId,
        text,
      });
      this.logSyntheticReplyDeliveryFailure({
        anchor: input.context.anchor,
        commandKind: input.command.kind,
        deliveryResult,
        completionKind: 'success',
        logger: input.logger,
      });
    } catch (error) {
      await this.completeFailure({
        command: input.command,
        anchor: input.context.anchor,
        welinkSessionId: input.welinkSessionId,
        error,
        ...(input.logger ? { logger: input.logger } : {}),
      });
    }
  }

  async completeFailure(input: {
    command: SlashCommandDescriptor;
    anchor: string;
    welinkSessionId?: string;
    error: unknown;
    logger?: BridgeLogger;
  }): Promise<void> {
    const failure = this.slashCommandExecutor.normalizeFailure(input.error);
    const text = this.dependencies.replyPresenter.presentFailure(input.command, failure);
    const deliveryResult = await this.dependencies.completionPort.completeFailure({
      anchor: input.anchor,
      welinkSessionId: input.welinkSessionId,
      text,
    });
    this.logSyntheticReplyDeliveryFailure({
      anchor: input.anchor,
      commandKind: input.command.kind,
      deliveryResult,
      completionKind: 'failure',
      logger: input.logger,
    });
  }

  private logSyntheticReplyDeliveryFailure(input: {
    anchor: string;
    commandKind: SlashCommand['kind'];
    deliveryResult: SlashCommandSuccessDeliveryResult | SlashCommandFailureDeliveryResult;
    completionKind: 'success' | 'failure';
    logger?: BridgeLogger;
  }): void {
    const { deliveryResult } = input;
    if (deliveryResult.success) {
      return;
    }
    input.logger?.error('runtime.slash.synthetic_reply_delivery_failed', {
      anchor: input.anchor,
      toolSessionId: input.anchor,
      command: input.commandKind,
      failureStage: deliveryResult.failureStage,
      messageType: this.resolveDeliveryFailureMessageType(deliveryResult.failureStage),
      completionSource: 'slash_control_plane',
      completionKind: input.completionKind,
    });
  }

  private resolveDeliveryFailureMessageType(
    failureStage: SlashCommandSuccessDeliveryFailureStage | SlashCommandFailureDeliveryFailureStage,
  ): 'message.updated' | 'message.part.updated' | 'message.part.delta' | 'tool_done' {
    if (failureStage === 'message.updated') {
      return 'message.updated';
    }
    if (failureStage === 'tool_done') {
      return 'tool_done';
    }
    if (failureStage === 'message.part.delta.text') {
      return 'message.part.delta';
    }
    return 'message.part.updated';
  }
}
