import {
  HEARTBEAT_MESSAGE_TYPE,
  REGISTER_MESSAGE_TYPE,
  type HeartbeatMessage,
  type RegisterMessage,
  type WireContractViolation,
} from '@agent-plugin/gateway-schema';

import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import { getMessageType } from '../telemetry/message-log-fields.ts';
import type { GatewayWireCodec } from '../../ports/GatewayWireCodec.ts';
import type { GatewaySendPayload } from '../../ports/GatewayClientMessages.ts';

function isControlMessageType(messageType: string): boolean {
  return messageType === REGISTER_MESSAGE_TYPE || messageType === HEARTBEAT_MESSAGE_TYPE;
}

/**
 * 出站协议闸口。
 * @remarks 统一收口 business/control 的最终协议校验，避免 sender 同时承担协议分支与传输职责。
 */
export interface OutboundProtocolGate {
  validateBusiness(message: GatewaySendPayload): GatewayBusinessOutboundMessage;
  validateControl(message: RegisterMessage | HeartbeatMessage): RegisterMessage | HeartbeatMessage;
}

/**
 * 对外可发送的业务消息，明确排除 register/heartbeat 这类内部控制帧。
 */
export type GatewayBusinessOutboundMessage = GatewaySendPayload;

/**
 * 统一出站协议校验实现。
 */
export class DefaultOutboundProtocolGate implements OutboundProtocolGate {
  private readonly wireCodec: GatewayWireCodec;

  constructor(wireCodec: GatewayWireCodec) {
    this.wireCodec = wireCodec;
  }

  validateBusiness(message: GatewaySendPayload): GatewayBusinessOutboundMessage {
    const messageType = getMessageType(message);
    if (isControlMessageType(messageType)) {
      throw this.toUnsupportedMessageTypeError(message);
    }

    const validation = this.wireCodec.validateGatewayUplinkBusinessMessage(message);
    if (!validation.ok) {
      throw this.toProtocolViolation(message, validation.error);
    }

    return validation.value as GatewayBusinessOutboundMessage;
  }

  validateControl(message: RegisterMessage | HeartbeatMessage): RegisterMessage | HeartbeatMessage {
    const messageType = getMessageType(message);
    if (!isControlMessageType(messageType)) {
      throw this.toUnsupportedMessageTypeError(message);
    }

    const validation = this.wireCodec.validateGatewayWireProtocolMessage(message);
    if (!validation.ok) {
      throw this.toProtocolViolation(message, validation.error);
    }
    return validation.value as RegisterMessage | HeartbeatMessage;
  }

  private toProtocolViolation(
    message: unknown,
    violation: WireContractViolation,
  ): GatewayClientError {
    return new GatewayClientError({
      code: 'GATEWAY_PROTOCOL_VIOLATION',
      category: 'protocol',
      retryable: false,
      message: violation.violation.message,
      details: {
        ...violation.violation,
        messageType: getMessageType(message),
      },
      cause: violation,
    });
  }

  private toUnsupportedMessageTypeError(message: unknown): GatewayClientError {
    return new GatewayClientError({
      code: 'GATEWAY_PROTOCOL_VIOLATION',
      category: 'protocol',
      retryable: false,
      message: `gateway_invalid_message_type:${getMessageType(message)}`,
      details: {
        stage: 'transport',
        code: 'unsupported_message',
        field: 'type',
        message: `Unsupported outbound message type: ${getMessageType(message)}`,
        messageType: getMessageType(message),
      },
    });
  }
}
