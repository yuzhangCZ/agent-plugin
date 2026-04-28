import { randomUUID } from 'crypto';
import type { GatewaySendPayload } from '@agent-plugin/gateway-client';
import { UPSTREAM_MESSAGE_TYPE } from '../gateway-wire/transport.js';

type GroupChatSyntheticToolEvent = Extract<GatewaySendPayload, { type: 'tool_event' }>;

const GROUP_CHAT_REPLY_TEXT = '本机器人不处理群聊消息，请勿在群内@提问';
const GROUP_CHAT_FINISH_REASON = 'stop';

function createSyntheticOpencodeMessageId(): string {
  return `msg_${randomUUID().replaceAll('-', '')}`;
}

function createSyntheticOpencodePartId(): string {
  return `prt_${randomUUID().replaceAll('-', '')}`;
}

/**
 * 构造群聊拦截的 synthetic OpenCode 事件序列。
 *
 * @remarks
 * 这里只负责协议编排与 synthetic id 生成，不负责发送、失败短路或 compat 状态推进。
 * 事件时序和字段形状尽量贴近真实 OpenCode 流量，避免下游 translator / 持久化 / 去重逻辑漂移。
 */
export function buildGroupChatSyntheticEvents(toolSessionId: string): {
  events: GroupChatSyntheticToolEvent[];
  messageId: string;
} {
  const messageId = createSyntheticOpencodeMessageId();
  const now = Date.now();
  const stepStartPartId = createSyntheticOpencodePartId();
  const textPartId = createSyntheticOpencodePartId();
  const stepFinishPartId = createSyntheticOpencodePartId();

  return {
    messageId,
    events: [
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: messageId,
              sessionID: toolSessionId,
              role: 'assistant',
              time: { created: now },
            },
          },
        },
      },
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'session.status',
          properties: {
            sessionID: toolSessionId,
            status: {
              type: 'busy',
            },
          },
        },
      },
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'message.part.updated',
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
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'message.part.delta',
          properties: {
            sessionID: toolSessionId,
            messageID: messageId,
            partID: textPartId,
            field: 'text',
            delta: GROUP_CHAT_REPLY_TEXT,
          },
        },
      },
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: textPartId,
              sessionID: toolSessionId,
              messageID: messageId,
              type: 'text',
              text: GROUP_CHAT_REPLY_TEXT,
            },
          },
        },
      },
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: stepFinishPartId,
              sessionID: toolSessionId,
              messageID: messageId,
              type: 'step-finish',
              reason: GROUP_CHAT_FINISH_REASON,
            },
          },
        },
      },
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: messageId,
              sessionID: toolSessionId,
              role: 'assistant',
              time: { created: now, updated: now },
            },
          },
        },
      },
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_EVENT,
        toolSessionId,
        event: {
          type: 'session.status',
          properties: {
            sessionID: toolSessionId,
            status: {
              type: 'idle',
            },
          },
        },
      },
    ],
  };
}
