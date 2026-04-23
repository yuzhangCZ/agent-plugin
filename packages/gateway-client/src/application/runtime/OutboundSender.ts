import {
  HEARTBEAT_MESSAGE_TYPE,
  type HeartbeatMessage,
  type RegisterMessage,
} from '@agent-plugin/gateway-schema';

import type { GatewaySendContext } from '../../domain/send-context.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import type { GatewayTransport } from '../../ports/GatewayTransport.ts';
import type { GatewayOutboundMessage, GatewaySendPayload } from '../../ports/GatewayClientMessages.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayBusinessOutboundMessage, OutboundProtocolGate } from '../protocol/OutboundProtocolGate.ts';
import { getMessageType } from '../telemetry/message-log-fields.ts';
import { resolveGatewayClientStage } from './error-facts.ts';

/**
 * 统一发送出口。
 * @remarks 在这里执行连接态校验、协议校验、日志采样与事件回传。
 */
export class OutboundSender {
  private readonly transport: GatewayTransport;
  private readonly outboundProtocolGate: OutboundProtocolGate;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    transport: GatewayTransport,
    outboundProtocolGate: OutboundProtocolGate,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.transport = transport;
    this.outboundProtocolGate = outboundProtocolGate;
    this.context = context;
    this.state = state;
  }

  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
    const normalizedMessage = this.normalizeProtocolError(
      () => this.outboundProtocolGate.validateBusiness(message),
    );
    this.dispatch(normalizedMessage, true, logContext);
  }

  sendInternalControl(message: HeartbeatMessage | RegisterMessage): void {
    const normalizedMessage = this.normalizeProtocolError(
      () => this.outboundProtocolGate.validateControl(message),
    );
    this.dispatch(normalizedMessage, false);
  }

  protected dispatch(message: GatewayOutboundMessage, isBusinessMessage: boolean, logContext?: GatewaySendContext): void {
    if (!this.state.isConnected()) {
      const messageType = getMessageType(message);
      this.context.logger?.warn?.('gateway.send.rejected_not_connected', {
        state: this.state.getState(),
        messageType,
      });
      throw new GatewayClientError({
        code: 'GATEWAY_NOT_CONNECTED',
        disposition: 'diagnostic',
        stage: resolveGatewayClientStage(this.state),
        retryable: true,
        message: 'gateway_not_connected',
        details: { state: this.state.getState(), messageType },
      });
    }

    const messageType = getMessageType(message);
    if (this.state.getState() !== 'READY' && isBusinessMessage) {
      this.context.logger?.warn?.('gateway.send.rejected_not_ready', {
        state: this.state.getState(),
        messageType,
      });
      throw new GatewayClientError({
        code: 'GATEWAY_NOT_READY',
        disposition: 'diagnostic',
        stage: resolveGatewayClientStage(this.state),
        retryable: true,
        message: 'Gateway connection is not ready. Cannot send business message.',
        details: { state: this.state.getState(), messageType },
      });
    }

    const serialized = JSON.stringify(message);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');
    this.context.telemetry.markSent(message, payloadBytes, logContext, isBusinessMessage);
    this.transport.send(serialized);
    this.context.sink.emitOutbound(message);
    if (messageType === HEARTBEAT_MESSAGE_TYPE) {
      this.context.sink.emitHeartbeat(message as HeartbeatMessage);
    }
  }

  private normalizeProtocolError<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof GatewayClientError) {
        throw new GatewayClientError({
          code: error.code,
          disposition: error.disposition,
          stage: resolveGatewayClientStage(this.state),
          retryable: error.retryable,
          message: error.message,
          details: error.details,
          cause: error.cause,
        });
      }
      throw error;
    }
  }
}
