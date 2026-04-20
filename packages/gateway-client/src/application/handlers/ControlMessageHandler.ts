import {
  REGISTER_OK_MESSAGE_TYPE,
  REGISTER_REJECTED_MESSAGE_TYPE,
  type RegisterOkMessage,
  type RegisterRejectedMessage,
} from '@agent-plugin/gateway-schema';

import { GATEWAY_CLIENT_STATE, type GatewayClientState } from '../../domain/state.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';

export type ControlMessageCommand =
  | { kind: 'noop' }
  | { kind: 'ready' }
  | { kind: 'rejected'; error: GatewayClientError }
  | { kind: 'error'; error: GatewayClientError };

/**
 * control frame 处理器。
 * @remarks 仅消费已完成协议分类的 control message，并返回结构化状态决策。
 */
export class ControlMessageHandler {
  handle(
    message: RegisterOkMessage | RegisterRejectedMessage,
    state: GatewayClientState,
    manuallyDisconnected: boolean,
  ): ControlMessageCommand {
    if (manuallyDisconnected) {
      return { kind: 'noop' };
    }

    if (message.type === REGISTER_OK_MESSAGE_TYPE) {
      if (state === GATEWAY_CLIENT_STATE.READY) {
        return { kind: 'noop' };
      }
      return { kind: 'ready' };
    }

    if (message.type === REGISTER_REJECTED_MESSAGE_TYPE) {
      return {
        kind: 'rejected',
        error: new GatewayClientError({
          code: 'GATEWAY_REGISTER_REJECTED',
          category: 'protocol',
          retryable: false,
          message: message.reason || 'gateway_register_rejected',
          details: { reason: message.reason },
        }),
      };
    }

    const exhaustiveMessage: never = message;
    return {
      kind: 'error',
      error: new GatewayClientError({
        code: 'GATEWAY_PROTOCOL_VIOLATION',
        category: 'protocol',
        retryable: false,
        message: `Unsupported gateway control message: ${String(exhaustiveMessage)}`,
        details: { messageType: String(exhaustiveMessage) },
      }),
    };
  }
}
