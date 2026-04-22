import {
  REGISTER_OK_MESSAGE_TYPE,
  REGISTER_REJECTED_MESSAGE_TYPE,
} from '@agent-plugin/gateway-schema';

import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import { buildProtocolViolationError } from './buildProtocolViolationError.ts';

export type HandshakeResult =
  | { kind: 'ready' }
  | { kind: 'rejected'; error: GatewayClientError }
  | { kind: 'protocol-error'; error: GatewayClientError };

/**
 * 握手控制帧语义处理器。
 * @remarks 只解释 register 阶段控制帧，不直接触碰 transport 或状态机。
 */
export class HandshakeFrameProcessor {
  process(frame: (GatewayInboundFrame & { kind: 'control' }) | (GatewayInboundFrame & { kind: 'invalid' })): HandshakeResult {
    if (frame.kind === 'invalid') {
      return {
        kind: 'protocol-error',
<<<<<<< HEAD
        error: buildProtocolViolationError(frame, {
          code: 'GATEWAY_HANDSHAKE_INVALID',
          disposition: 'startup_failure',
          stage: 'handshake',
        }),
=======
        error: buildProtocolViolationError(frame, { source: 'handshake', phase: 'before_ready' }),
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
      };
    }

    if (frame.message.type === REGISTER_OK_MESSAGE_TYPE) {
      return { kind: 'ready' };
    }

    if (frame.message.type === REGISTER_REJECTED_MESSAGE_TYPE) {
      return {
        kind: 'rejected',
        error: new GatewayClientError({
<<<<<<< HEAD
          code: 'GATEWAY_HANDSHAKE_REJECTED',
          disposition: 'startup_failure',
          stage: 'handshake',
=======
          code: 'GATEWAY_REGISTER_REJECTED',
          source: 'handshake',
          phase: 'before_ready',
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
          retryable: false,
          message: frame.message.reason || 'gateway_register_rejected',
          details: { reason: frame.message.reason },
        }),
      };
    }

    return {
      kind: 'protocol-error',
      error: new GatewayClientError({
<<<<<<< HEAD
        code: 'GATEWAY_HANDSHAKE_INVALID',
        disposition: 'startup_failure',
        stage: 'handshake',
=======
        code: 'GATEWAY_PROTOCOL_VIOLATION',
        source: 'handshake',
        phase: 'before_ready',
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
        retryable: false,
        message: 'Unsupported gateway control message',
        details: { messageType: frame.messageType },
      }),
    };
  }
}
