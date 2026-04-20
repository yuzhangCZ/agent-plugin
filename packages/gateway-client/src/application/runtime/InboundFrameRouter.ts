import {
  REGISTER_OK_MESSAGE_TYPE,
  REGISTER_REJECTED_MESSAGE_TYPE,
} from '@agent-plugin/gateway-schema';

import { InboundFrameDecoder } from '../protocol/InboundFrameDecoder.ts';
import { InboundProtocolAdapter } from '../protocol/InboundProtocolAdapter.ts';
import type { BusinessMessageHandler } from '../handlers/BusinessMessageHandler.ts';
import type { ControlMessageHandler } from '../handlers/ControlMessageHandler.ts';
import type { GatewayTransport } from '../../ports/GatewayTransport.ts';
import type { GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import { buildMessagePreview } from '../telemetry/message-log-fields.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import { HeartbeatLoop } from './HeartbeatLoop.ts';
import { ReconnectOrchestrator } from './ReconnectOrchestrator.ts';

function logDebug(logger: GatewayRuntimeContext['logger'], message: string, meta?: Record<string, unknown>): void {
  if (!logger) {
    return;
  }
  if (logger.debug) {
    logger.debug(message, meta);
    return;
  }
  logger.info?.(message, meta);
}

/**
 * 入站帧路由器，负责控制帧与业务帧分流及 READY gating。
 */
export class InboundFrameRouter {
  private readonly inboundFrameDecoder: InboundFrameDecoder;
  private readonly inboundProtocolAdapter: InboundProtocolAdapter;
  private readonly controlMessageHandler: ControlMessageHandler;
  private readonly businessMessageHandler: BusinessMessageHandler;
  private readonly transport: GatewayTransport;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    inboundFrameDecoder: InboundFrameDecoder,
    inboundProtocolAdapter: InboundProtocolAdapter,
    controlMessageHandler: ControlMessageHandler,
    businessMessageHandler: BusinessMessageHandler,
    transport: GatewayTransport,
    heartbeatLoop: HeartbeatLoop,
    reconnectOrchestrator: ReconnectOrchestrator,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.inboundFrameDecoder = inboundFrameDecoder;
    this.inboundProtocolAdapter = inboundProtocolAdapter;
    this.controlMessageHandler = controlMessageHandler;
    this.businessMessageHandler = businessMessageHandler;
    this.transport = transport;
    this.heartbeatLoop = heartbeatLoop;
    this.reconnectOrchestrator = reconnectOrchestrator;
    this.context = context;
    this.state = state;
  }

  async route(event: { data: string | ArrayBuffer | Blob | Uint8Array }): Promise<void> {
    this.context.telemetry.logRawFrame('onMessage', event.data);
    const decoded = await this.inboundFrameDecoder.decode(event.data);
    if (decoded.kind !== 'parsed') {
      this.context.sink.emitInbound(decoded);
      return;
    }
    const frameBytes = Buffer.byteLength(decoded.rawText, 'utf8');
    const parsed = decoded.value;
    const { messageType, gatewayMessageId } = this.context.telemetry.markReceived(parsed, frameBytes);
    const inboundFrame = this.inboundProtocolAdapter.adapt(parsed);
    this.context.sink.emitInbound(inboundFrame);

    if (messageType === REGISTER_OK_MESSAGE_TYPE || messageType === REGISTER_REJECTED_MESSAGE_TYPE) {
      if (inboundFrame.kind === 'control') {
        this.handleControlMessage(inboundFrame);
      } else if (inboundFrame.kind === 'invalid') {
        this.failClosedOnInvalidControlFrame(inboundFrame);
      }
      return;
    }

    if (inboundFrame.kind === 'invalid') {
      this.emitProtocolError(inboundFrame, false);
      return;
    }

    if (inboundFrame.kind !== 'business') {
      return;
    }

    const command = this.businessMessageHandler.handle(inboundFrame.message, this.state.getState());
    if (command.kind === 'ignored-not-ready') {
      logDebug(this.context.logger, 'gateway.message.received_not_ready', {
        state: this.state.getState(),
        messageType,
        gatewayMessageId,
      });
      return;
    }

    this.context.sink.emitMessage(command.message);
  }

  private failClosedOnInvalidControlFrame(inboundFrame: GatewayInboundFrame & { kind: 'invalid' }): void {
    const error = this.buildProtocolViolationError(inboundFrame);
    this.context.logger?.error?.('gateway.control.validation_failed', {
      ...error.details,
    });
    // control frame 协议违约直接 fail-closed，避免握手停在半连接状态。
    this.state.setManuallyDisconnected(true);
    this.transport.close();
    this.context.sink.emitError(error);
  }

  private emitProtocolError(inboundFrame: GatewayInboundFrame & { kind: 'invalid' }, failClosed: boolean): void {
    const error = this.buildProtocolViolationError(inboundFrame);
    this.context.logger?.error?.('gateway.business.validation_failed', {
      ...error.details,
      failClosed,
    });
    if (failClosed) {
      this.state.setManuallyDisconnected(true);
      this.transport.close();
    }
    this.context.sink.emitError(error);
  }

  private buildProtocolViolationError(inboundFrame: GatewayInboundFrame & { kind: 'invalid' }): GatewayClientError {
    return new GatewayClientError({
      code: 'GATEWAY_PROTOCOL_VIOLATION',
      category: 'protocol',
      retryable: false,
      message: inboundFrame.violation.violation.message,
      details: {
        ...inboundFrame.violation.violation,
        gatewayMessageId: inboundFrame.gatewayMessageId,
        action: inboundFrame.action ?? inboundFrame.violation.violation.action,
        welinkSessionId: inboundFrame.welinkSessionId ?? inboundFrame.violation.violation.welinkSessionId,
        toolSessionId: inboundFrame.toolSessionId ?? inboundFrame.violation.violation.toolSessionId,
        messagePreview: buildMessagePreview(inboundFrame.rawPreview),
      },
      cause: inboundFrame.violation,
    });
  }

  private handleControlMessage(inboundFrame: GatewayInboundFrame & { kind: 'control' }): void {
    const command = this.controlMessageHandler.handle(
      inboundFrame.message,
      this.state.getState(),
      this.state.isManuallyDisconnected(),
    );

    if (command.kind === 'noop') {
      if (this.state.getState() === 'READY') {
        this.context.logger?.warn?.('gateway.register.duplicate_ok');
      }
      return;
    }

    if (command.kind === 'ready') {
      this.reconnectOrchestrator.reset();
      this.context.logger?.info?.('gateway.register.accepted');
      this.state.setState('READY');
      this.context.logger?.info?.('gateway.ready');
      this.heartbeatLoop.start();
      return;
    }

    if (command.kind === 'rejected') {
      this.context.logger?.error?.('gateway.register.rejected', command.error.details);
      this.state.setManuallyDisconnected(true);
      this.transport.close();
      this.context.sink.emitError(command.error);
      return;
    }

    this.context.logger?.error?.('gateway.control.validation_failed', {
      ...command.error.details,
    });
    this.context.sink.emitError(command.error);
  }
}
