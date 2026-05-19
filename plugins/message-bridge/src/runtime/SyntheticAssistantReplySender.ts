import type {
  GatewayClient,
  GatewaySendContext as GatewaySendLogContext,
  GatewaySendPayload,
} from '@agent-plugin/gateway-client';

import { TOOL_EVENT_TYPE } from '../gateway-wire/tool-event.js';
import type { BridgeLogger } from './AppLogger.js';
import type { GatewaySessionSenderPort } from './GatewaySessionSender.js';
import {
  SyntheticAssistantReplySequenceBuilder,
  type SyntheticAssistantReplySequence,
} from './SyntheticAssistantReplySequenceBuilder.js';

type ToolEventPayload = Extract<GatewaySendPayload, { type: 'tool_event' }>;

/**
 * synthetic assistant reply 执行结果。
 * @remarks 调用方只关心是否完整发完，以及失败停在哪个阶段。
 */
export interface SyntheticAssistantReplyResult {
  success: boolean;
  failureStage?:
    | 'message.updated'
    | 'message.part.updated.step-start'
    | 'message.part.updated.text-seed'
    | 'message.part.delta.text'
    | 'message.part.updated.text-final'
    | 'message.part.updated.step-finish'
    | 'tool_done';
}

/**
 * 插件侧本地 assistant 文本回复发送器。
 * @remarks 负责构造 canonical synthetic reply、统一校验发送、并返回显式阶段结果。
 */
export class SyntheticAssistantReplySender {
  private readonly sequenceBuilder = new SyntheticAssistantReplySequenceBuilder();

  constructor(
    private readonly sessionSender: GatewaySessionSenderPort,
    private readonly validateGatewayUplinkBusinessMessageOrLog: (
      message: GatewaySendPayload,
      logContext: GatewaySendLogContext,
      logger: BridgeLogger,
    ) => GatewaySendPayload | null,
  ) {}

  execute(input: {
    connection: GatewayClient;
    toolSessionId: string;
    welinkSessionId?: string;
    text: string;
    logger: BridgeLogger;
    traceId: string;
    gatewayMessageId?: string;
    action: 'chat';
    sendToolDone: (
      toolSessionId: string,
      welinkSessionId: string | undefined,
      logOptions: {
        connection: GatewayClient;
        logger: BridgeLogger;
        traceId: string;
        gatewayMessageId?: string;
        action: 'chat';
      },
    ) => boolean,
  }): SyntheticAssistantReplyResult {
    const sequence = this.sequenceBuilder.build({
      toolSessionId: input.toolSessionId,
      text: input.text,
    });
    const commonLogOptions = {
      connection: input.connection,
      logger: input.logger,
      traceId: input.traceId,
      gatewayMessageId: input.gatewayMessageId,
      action: input.action,
      toolSessionId: input.toolSessionId,
    } as const;

    if (!this.sendToolEvent(sequence.messageUpdated, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_UPDATED,
    })) {
      return { success: false, failureStage: 'message.updated' };
    }

    if (!this.sendToolEvent(sequence.stepStart, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    })) {
      return { success: false, failureStage: 'message.part.updated.step-start' };
    }

    if (!this.sendToolEvent(sequence.textSeedUpdated, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    })) {
      return { success: false, failureStage: 'message.part.updated.text-seed' };
    }

    if (!this.sendToolEvent(sequence.textDelta, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_PART_DELTA,
    })) {
      return { success: false, failureStage: 'message.part.delta.text' };
    }

    if (!this.sendToolEvent(sequence.textFinalUpdated, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    })) {
      return { success: false, failureStage: 'message.part.updated.text-final' };
    }

    if (!this.sendToolEvent(sequence.stepFinish, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    })) {
      return { success: false, failureStage: 'message.part.updated.step-finish' };
    }

    if (!input.sendToolDone(input.toolSessionId, input.welinkSessionId, {
      connection: input.connection,
      logger: input.logger,
      traceId: input.traceId,
      gatewayMessageId: input.gatewayMessageId,
      action: input.action,
    })) {
      return { success: false, failureStage: 'tool_done' };
    }

    return { success: true };
  }

  private sendToolEvent(
    message: ToolEventPayload,
    logOptions: {
      connection: GatewayClient;
      logger: BridgeLogger;
      traceId: string;
      gatewayMessageId?: string;
      action: 'chat';
      toolSessionId: string;
      eventType: string;
    },
  ): boolean {
    logOptions.logger.info('runtime.tool_event.sending', {
      toolSessionId: logOptions.toolSessionId,
      eventType: logOptions.eventType,
      action: logOptions.action,
    });

    const toolEventLogContext: GatewaySendLogContext = {
      traceId: logOptions.traceId,
      runtimeTraceId: logOptions.logger.getTraceId(),
      gatewayMessageId: logOptions.gatewayMessageId,
      welinkSessionId: undefined,
      action: logOptions.action,
      toolSessionId: logOptions.toolSessionId,
      eventType: logOptions.eventType,
    };
    const validatedToolEvent = this.validateGatewayUplinkBusinessMessageOrLog(
      message,
      toolEventLogContext,
      logOptions.logger,
    );
    if (!validatedToolEvent) {
      return false;
    }

    return this.sessionSender.sendIfActive(logOptions.connection, validatedToolEvent, toolEventLogContext);
  }
}
