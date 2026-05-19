import type {
  HostModelCatalogPort,
  HostPromptExecutionPort,
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

/** 控制面 orchestrator：统一处理 slash 命令、副作用与完成态。 */
export class DefaultSlashCommandOrchestrator {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
    modelOverrideStore: SessionModelOverrideStore;
    hostSessionCreationPort: HostSessionCreationPort;
    hostSessionQueryPort: HostSessionQueryPort;
    hostPromptExecutionPort: HostPromptExecutionPort;
    hostModelCatalogPort: HostModelCatalogPort;
    replyPresenter: SlashCommandReplyPresenter;
    completionPort: SlashCommandCompletionPort;
  }) {}

  async execute(input: {
    command: SlashCommand;
    context: SlashCommandContext;
    createContext?: HostSessionCreateContext;
    logger?: BridgeLogger;
  }): Promise<void> {
    try {
      const result = await this.executeCommand(input.command, input.context, input.createContext);
      const text = this.dependencies.replyPresenter.presentSuccess(result);
      const deliveryResult = await this.dependencies.completionPort.completeSuccess({
        anchor: input.context.anchor,
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
        error,
        ...(input.logger ? { logger: input.logger } : {}),
      });
    }
  }

  async completeFailure(input: {
    command: SlashCommandDescriptor;
    anchor: string;
    error: unknown;
    logger?: BridgeLogger;
  }): Promise<void> {
    const failure = this.normalizeFailure(input.error);
    const text = this.dependencies.replyPresenter.presentFailure(input.command, failure);
    const deliveryResult = await this.dependencies.completionPort.completeFailure({
      anchor: input.anchor,
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

  private async executeCommand(
    command: SlashCommand,
    context: SlashCommandContext,
    createContext?: HostSessionCreateContext,
  ) {
    switch (command.kind) {
      case 'new': {
        const previousSessionId = context.activeOpencodeSessionId;
        const session = await this.dependencies.hostSessionCreationPort.createSession(createContext);
        this.rebind(context.anchor, previousSessionId, session.id);
        return { kind: 'new' as const, session, previousSessionId };
      }
      case 'sessions': {
        const sessions = await this.dependencies.hostSessionQueryPort.listSessions(context.scope ?? {});
        return {
          kind: 'sessions' as const,
          sessions,
          activeSessionId: context.activeOpencodeSessionId,
        };
      }
      case 'session': {
        const sessions = await this.dependencies.hostSessionQueryPort.listSessions(context.scope ?? {});
        const target = sessions.find((session) => session.id === command.sessionId);
        if (!target) {
          throw this.asFailure('session_out_of_scope');
        }
        this.rebind(context.anchor, context.activeOpencodeSessionId, target.id);
        return {
          kind: 'session' as const,
          session: target,
          previousSessionId: context.activeOpencodeSessionId,
        };
      }
      case 'models': {
        const models = await this.dependencies.hostModelCatalogPort.listModels();
        return { kind: 'models' as const, models };
      }
      case 'model': {
        const sessionId = context.activeOpencodeSessionId;
        if (!sessionId) {
          throw this.asFailure('session_not_found');
        }
        const models = await this.dependencies.hostModelCatalogPort.listModels();
        const exists = models.some((item) => item.providerId === command.providerId && item.modelId === command.modelId);
        if (!exists) {
          throw this.asFailure('model_not_found');
        }
        const override = {
          providerId: command.providerId,
          modelId: command.modelId,
        };
        this.dependencies.modelOverrideStore.set(sessionId, override);
        return {
          kind: 'model' as const,
          sessionId,
          modelOverride: override,
        };
      }
      default:
        throw this.asFailure('invalid_command');
    }
  }

  private rebind(anchor: string, previousSessionId: string | undefined, nextSessionId: string): void {
    if (previousSessionId && previousSessionId !== nextSessionId) {
      this.dependencies.ownershipResolver.detach(previousSessionId);
    }
    this.dependencies.bindingStore.bind(anchor, nextSessionId);
    this.dependencies.ownershipResolver.attach(nextSessionId, anchor);
  }

  private asFailure(code: SlashCommandFailureCode): SlashCommandFailure {
    return { code };
  }

  private normalizeFailure(error: unknown): SlashCommandFailure {
    const sourceErrorCode = this.extractSourceErrorCode(error);
    if (sourceErrorCode === 'session_not_found') {
      return { code: 'session_not_found' };
    }

    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && typeof (error as { code: unknown }).code === 'string'
    ) {
      const normalizedError = error as {
        code: string;
        reasonKey?: SlashCommandFailure['reasonKey'];
      };
      return {
        code: this.isSlashCommandFailureCode(normalizedError.code) ? normalizedError.code : 'sdk_unreachable',
        ...(typeof normalizedError.reasonKey === 'string' ? { reasonKey: normalizedError.reasonKey } : {}),
      };
    }

    return {
      code: 'sdk_unreachable',
    };
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
  ): 'message.updated' | 'message.part.updated' | 'tool_done' {
    if (failureStage === 'message.updated') {
      return 'message.updated';
    }
    if (failureStage === 'tool_done') {
      return 'tool_done';
    }
    return 'message.part.updated';
  }
}
