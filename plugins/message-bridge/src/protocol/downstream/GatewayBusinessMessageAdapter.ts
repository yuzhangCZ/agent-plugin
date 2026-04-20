import type { GatewayBusinessMessage } from '@agent-plugin/gateway-client';

import type { BridgeLogger } from '../../runtime/AppLogger.js';
import type {
  DownstreamNormalizationError,
  NormalizeResult,
  NormalizedDownstreamMessage,
} from './DownstreamMessageTypes.js';

function ok<T>(value: T): NormalizeResult<T> {
  return { ok: true, value };
}

function fail(error: DownstreamNormalizationError): NormalizeResult<never> {
  return { ok: false, error };
}

function withOptionalWelinkSessionId(message: { welinkSessionId?: string }): string | undefined {
  return message.welinkSessionId ?? undefined;
}

function adaptInvokeMessage(
  message: Extract<GatewayBusinessMessage, { type: 'invoke' }>,
): NormalizeResult<NormalizedDownstreamMessage> {
  switch (message.action) {
    case 'chat':
      return ok({
        type: 'invoke',
        action: 'chat',
        welinkSessionId: withOptionalWelinkSessionId(message),
        payload: {
          toolSessionId: message.payload.toolSessionId,
          text: message.payload.text,
          ...(message.payload.assistantId ? { assistantId: message.payload.assistantId } : {}),
        },
      });
    case 'create_session':
      return ok({
        type: 'invoke',
        action: 'create_session',
        welinkSessionId: message.welinkSessionId,
        payload: {
          ...(message.payload.title ? { title: message.payload.title } : {}),
          ...(message.payload.assistantId ? { assistantId: message.payload.assistantId } : {}),
        },
      });
    case 'close_session':
      return ok({
        type: 'invoke',
        action: 'close_session',
        welinkSessionId: withOptionalWelinkSessionId(message),
        payload: {
          toolSessionId: message.payload.toolSessionId,
        },
      });
    case 'permission_reply':
      return ok({
        type: 'invoke',
        action: 'permission_reply',
        welinkSessionId: withOptionalWelinkSessionId(message),
        payload: {
          permissionId: message.payload.permissionId,
          toolSessionId: message.payload.toolSessionId,
          response: message.payload.response,
        },
      });
    case 'abort_session':
      return ok({
        type: 'invoke',
        action: 'abort_session',
        welinkSessionId: withOptionalWelinkSessionId(message),
        payload: {
          toolSessionId: message.payload.toolSessionId,
        },
      });
    case 'question_reply':
      return ok({
        type: 'invoke',
        action: 'question_reply',
        welinkSessionId: withOptionalWelinkSessionId(message),
        payload: {
          toolSessionId: message.payload.toolSessionId,
          answer: message.payload.answer,
          ...(message.payload.toolCallId ? { toolCallId: message.payload.toolCallId } : {}),
        },
      });
    default: {
      const unsupportedAction = (message as { action: string }).action;
      return fail({
        stage: 'payload',
        code: 'unsupported_action',
        field: 'action',
        message: `Unsupported invoke action: ${unsupportedAction}`,
        messageType: 'invoke',
        action: unsupportedAction,
        welinkSessionId: withOptionalWelinkSessionId(message),
      });
    }
  }
}

/**
 * `message-bridge` 插件私有下行适配入口。
 *
 * @remarks
 * 共享 `gateway-client` 已经完成主链路 typed facade 归一化；这里信任 facade
 * 输出，只做本地 shape 收口：补齐可选 `welinkSessionId` 的 `undefined` 语义，
 * 并预留未来插件私有 compat/fail-closed seam。
 */
export function adaptGatewayBusinessMessage(
  message: GatewayBusinessMessage,
  _logger?: Pick<BridgeLogger, 'warn'>,
): NormalizeResult<NormalizedDownstreamMessage> {
  if (message.type === 'status_query') {
    return ok({ type: 'status_query' });
  }

  return adaptInvokeMessage(message);
}
