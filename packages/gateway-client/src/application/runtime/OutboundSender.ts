import {
  TRANSPORT_UPSTREAM_MESSAGE_TYPES,
  type HeartbeatMessage,
  type RegisterMessage,
} from '@agent-plugin/gateway-wire-v1';

import type { GatewaySendContext } from '../../domain/send-context.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import type { GatewayTransport } from '../../ports/GatewayTransport.ts';
import type { GatewayWireCodec } from '../../ports/GatewayWireCodec.ts';
import type { GatewaySendPayload } from '../../ports/GatewayClientMessages.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import { getMessageType } from '../telemetry/message-log-fields.ts';

const [REGISTER_MESSAGE_TYPE] = TRANSPORT_UPSTREAM_MESSAGE_TYPES;
const HEARTBEAT_MESSAGE_TYPE = TRANSPORT_UPSTREAM_MESSAGE_TYPES[3];

function isControlSendType(messageType: string): boolean {
  return messageType === REGISTER_MESSAGE_TYPE || messageType === HEARTBEAT_MESSAGE_TYPE;
}

/**
 * 统一发送出口。
 * @remarks 在这里执行连接态校验、协议校验、日志采样与事件回传。
 */
export class OutboundSender {
  private readonly transport: GatewayTransport;
  private readonly wireCodec: GatewayWireCodec;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    transport: GatewayTransport,
    wireCodec: GatewayWireCodec,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.transport = transport;
    this.wireCodec = wireCodec;
    this.context = context;
    this.state = state;
  }

  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
    if (!this.state.isConnected()) {
      const messageType = getMessageType(message);
      this.context.logger?.warn?.('gateway.send.rejected_not_connected', {
        state: this.state.getState(),
        messageType,
      });
      throw new GatewayClientError({
        code: 'GATEWAY_NOT_CONNECTED',
        category: 'state',
        retryable: true,
        message: 'gateway_not_connected',
        details: { state: this.state.getState(), messageType },
      });
    }

    const messageType = getMessageType(message);
    const isControlMessage = isControlSendType(messageType);
    if (this.state.getState() !== 'READY' && !isControlMessage) {
      this.context.logger?.warn?.('gateway.send.rejected_not_ready', {
        state: this.state.getState(),
        messageType,
      });
      throw new GatewayClientError({
        code: 'GATEWAY_NOT_READY',
        category: 'state',
        retryable: true,
        message: 'Gateway connection is not ready. Cannot send business message.',
        details: { state: this.state.getState(), messageType },
      });
    }

    const normalizedMessage = isControlMessage ? this.validateControlSendMessage(message) : message;
    const serialized = JSON.stringify(normalizedMessage);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');
    this.context.telemetry.markSent(normalizedMessage, payloadBytes, logContext, !isControlMessage);
    this.transport.send(serialized);
    this.context.sink.emitOutbound(normalizedMessage);
    if (messageType === HEARTBEAT_MESSAGE_TYPE) {
      this.context.sink.emitHeartbeat(normalizedMessage as HeartbeatMessage);
    }
  }

  private validateControlSendMessage(message: GatewaySendPayload): RegisterMessage | HeartbeatMessage {
    const validation = this.wireCodec.validateTransportMessage(message);
    if (
      validation.ok &&
      (validation.value.type === REGISTER_MESSAGE_TYPE || validation.value.type === HEARTBEAT_MESSAGE_TYPE)
    ) {
      return validation.value as RegisterMessage | HeartbeatMessage;
    }

    const violation = validation.ok
      ? {
          stage: 'transport',
          code: 'unsupported_message',
          field: 'type',
          message: `Unsupported control message type: ${getMessageType(message)}`,
        }
      : validation.error.violation;
    this.context.logger?.error?.('gateway.send.rejected_invalid_protocol', {
      messageType: getMessageType(message),
      stage: violation.stage,
      errorCode: violation.code,
      field: violation.field,
      errorMessage: violation.message,
    });
    throw new GatewayClientError({
      code: 'GATEWAY_PROTOCOL_VIOLATION',
      category: 'protocol',
      retryable: false,
      message: 'gateway_invalid_transport_message',
      details: { ...violation },
      cause: validation.ok ? undefined : validation.error,
    });
  }
}
