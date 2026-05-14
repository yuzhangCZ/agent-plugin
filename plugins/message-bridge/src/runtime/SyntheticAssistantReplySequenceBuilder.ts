import { randomUUID } from 'crypto';

import type { GatewaySendPayload } from '@agent-plugin/gateway-client';

import { TOOL_EVENT_TYPE } from '../gateway-wire/tool-event.js';
import { UPSTREAM_MESSAGE_TYPE } from '../gateway-wire/transport.js';

type ToolEventPayload = Extract<GatewaySendPayload, { type: 'tool_event' }>;

/** canonical synthetic assistant reply 的四段事件序列。 */
export interface SyntheticAssistantReplySequence {
  messageUpdated: ToolEventPayload;
  stepStart: ToolEventPayload;
  text: ToolEventPayload;
  stepFinish: ToolEventPayload;
}

/** 统一构造插件侧本地 assistant synthetic reply 事件序列。 */
export class SyntheticAssistantReplySequenceBuilder {
  build(input: { toolSessionId: string; text: string }): SyntheticAssistantReplySequence {
    const createdAt = Date.now();
    const messageId = this.createSyntheticMessageId();
    const stepStartPartId = this.createSyntheticPartId();
    const textPartId = this.createSyntheticPartId();
    const stepFinishPartId = this.createSyntheticPartId();

    return {
      messageUpdated: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId: input.toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_UPDATED,
          properties: {
            info: {
              id: messageId,
              sessionID: input.toolSessionId,
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
        toolSessionId: input.toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
          properties: {
            part: {
              id: stepStartPartId,
              sessionID: input.toolSessionId,
              messageID: messageId,
              type: 'step-start',
            },
          },
        },
      },
      text: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId: input.toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
          properties: {
            part: {
              id: textPartId,
              sessionID: input.toolSessionId,
              messageID: messageId,
              type: 'text',
              text: input.text,
            },
          },
        },
      },
      stepFinish: {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId: input.toolSessionId,
        event: {
          type: TOOL_EVENT_TYPE.MESSAGE_PART_UPDATED,
          properties: {
            part: {
              id: stepFinishPartId,
              sessionID: input.toolSessionId,
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
}
