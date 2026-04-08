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

// ControlMessageHandler 只负责解析 control frame 并返回领域决策，不直接触碰 transport 或事件总线。
export class ControlMessageHandler {
  private readonly wireCodec: GatewayWireCodec;

  constructor(wireCodec: GatewayWireCodec) {
    this.wireCodec = wireCodec;
  }

  handle(message: unknown, state: GatewayClientState, manuallyDisconnected: boolean): ControlMessageCommand {
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
