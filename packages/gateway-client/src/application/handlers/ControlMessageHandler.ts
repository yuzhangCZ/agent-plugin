import { TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '@agent-plugin/gateway-wire-v1';

import { GATEWAY_CLIENT_STATE, type GatewayClientState } from '../../domain/state.ts';
import type { GatewayWireCodec } from '../../ports/GatewayWireCodec.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';

const [, REGISTER_OK_MESSAGE_TYPE, REGISTER_REJECTED_MESSAGE_TYPE] = TRANSPORT_UPSTREAM_MESSAGE_TYPES;

export type ControlMessageCommand =
  | { kind: 'noop' }
  | { kind: 'ready' }
  | { kind: 'rejected'; error: GatewayClientError }
  | { kind: 'error'; error: GatewayClientError };

/**
 * control frame 处理器。
 * @remarks 统一执行 fail-closed 校验并返回结构化决策。
 */
export class ControlMessageHandler {
  private readonly wireCodec: GatewayWireCodec;

  constructor(wireCodec: GatewayWireCodec) {
    this.wireCodec = wireCodec;
  }

  handle(message: unknown, state: GatewayClientState, manuallyDisconnected: boolean): ControlMessageCommand {
    // fail-closed：control frame 一旦校验失败，统一返回结构化协议错误，由上层决定如何记日志和发事件。
    if (manuallyDisconnected) {
      return { kind: 'noop' };
    }

    const validation = this.wireCodec.validateTransportMessage(message);
    if (!validation.ok) {
      return {
        kind: 'error',
        error: new GatewayClientError({
          code: 'GATEWAY_PROTOCOL_VIOLATION',
          category: 'protocol',
          retryable: false,
          message: validation.error.message,
          details: { ...validation.error.toJSON() },
          cause: validation.error,
        }),
      };
    }

    if (validation.value.type === REGISTER_OK_MESSAGE_TYPE) {
      if (state === GATEWAY_CLIENT_STATE.READY) {
        return { kind: 'noop' };
      }
      return { kind: 'ready' };
    }

    if (validation.value.type === REGISTER_REJECTED_MESSAGE_TYPE) {
      return {
        kind: 'rejected',
        error: new GatewayClientError({
          code: 'GATEWAY_REGISTER_REJECTED',
          category: 'protocol',
          retryable: false,
          message: validation.value.reason || 'gateway_register_rejected',
          details: { reason: validation.value.reason },
        }),
      };
    }

    return {
      kind: 'error',
      error: new GatewayClientError({
        code: 'GATEWAY_PROTOCOL_VIOLATION',
        category: 'protocol',
        retryable: false,
        message: `Unsupported gateway control message: ${validation.value.type}`,
        details: { messageType: validation.value.type },
      }),
    };
  }
}
