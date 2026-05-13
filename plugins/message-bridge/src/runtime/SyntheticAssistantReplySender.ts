import { randomUUID } from 'crypto';

import type {
  GatewayClient,
  GatewaySendContext as GatewaySendLogContext,
  GatewaySendPayload,
} from '@agent-plugin/gateway-client';

import { TOOL_EVENT_TYPE } from '../gateway-wire/tool-event.js';
import { UPSTREAM_MESSAGE_TYPE } from '../gateway-wire/transport.js';
import type { BridgeLogger } from './AppLogger.js';
import type { GatewaySessionSenderPort } from './GatewaySessionSender.js';

type ToolEventPayload = Extract<GatewaySendPayload, { type: 'tool_event' }>;

interface SyntheticAssistantReplySequence {
  messageUpdated: ToolEventPayload;
  stepStart: ToolEventPayload;
  text: ToolEventPayload;
  stepFinish: ToolEventPayload;
}

/**
 * synthetic assistant reply 执行结果。
 * @remarks 调用方只关心是否完整发完，以及失败停在哪个阶段。
 */
export interface SyntheticAssistantReplyResult {
  success: boolean;
  failureStage?: 'message.updated' | 'message.part.updated.step-start' | 'message.part.updated.text' | 'message.part.updated.step-finish' | 'tool_done';
}

/**
 * 插件侧本地 assistant 文本回复发送器。
 * @remarks 负责构造 canonical synthetic reply、统一校验发送、并返回显式阶段结果。
 */
export class SyntheticAssistantReplySender {
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
    const sequence = this.buildSyntheticEventSequence(input.toolSessionId, input.text);
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

    if (!this.sendToolEvent(sequence.text, {
      ...commonLogOptions,
      eventType: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
    })) {
      return { success: false, failureStage: 'message.part.updated.text' };
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

  private buildSyntheticEventSequence(
    toolSessionId: string,
    text: string,
  ): SyntheticAssistantReplySequence {
    const createdAt = Date.now();
    const messageId = this.createSyntheticMessageId();
    const stepStartPartId = this.createSyntheticPartId();
    const textPartId = this.createSyntheticPartId();
    const stepFinishPartId = this.createSyntheticPartId();

    return {
      messageUpdated: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_UPDATED,
          properties: {
            info: {
              id: messageId,
              sessionID: toolSessionId,
              role: 'assistant',
              time: {
                created: createdAt,
              },
            },
          },
        },
      },
      stepStart: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
          properties: {
            part: {
              id: stepStartPartId,
              sessionID: toolSessionId,
              messageID: messageId,
              type: 'step-start',
            },
          },
        },
      },
      text: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
          properties: {
            part: {
              id: textPartId,
              sessionID: toolSessionId,
              messageID: messageId,
              type: 'text',
              text,
            },
          },
        },
      },
      stepFinish: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
          properties: {
            part: {
              id: stepFinishPartId,
              sessionID: toolSessionId,
              messageID: messageId,
              type: 'step-finish',
              reason: 'stop',
            },
          },
        },
      },
    };
  }

  private createSyntheticMessageId(): string {
    return `msg_${randomUUID().split('-').join('')}`;
  }

  private createSyntheticPartId(): string {
    return `prt_${randomUUID().split('-').join('')}`;
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
