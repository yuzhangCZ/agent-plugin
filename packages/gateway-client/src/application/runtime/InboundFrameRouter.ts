import { TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '@agent-plugin/gateway-wire-v1';

import type { BusinessMessageHandler } from '../handlers/BusinessMessageHandler.ts';
import type { ControlMessageHandler } from '../handlers/ControlMessageHandler.ts';
import type { GatewayTransport } from '../../ports/GatewayTransport.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import { HeartbeatLoop } from './HeartbeatLoop.ts';
import { ReconnectOrchestrator } from './ReconnectOrchestrator.ts';

const REGISTER_OK_MESSAGE_TYPE = TRANSPORT_UPSTREAM_MESSAGE_TYPES[1];
const REGISTER_REJECTED_MESSAGE_TYPE = TRANSPORT_UPSTREAM_MESSAGE_TYPES[2];

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

export class InboundFrameRouter {
  private readonly controlMessageHandler: ControlMessageHandler;
  private readonly businessMessageHandler: BusinessMessageHandler;
  private readonly transport: GatewayTransport;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    controlMessageHandler: ControlMessageHandler,
    businessMessageHandler: BusinessMessageHandler,
    transport: GatewayTransport,
    heartbeatLoop: HeartbeatLoop,
    reconnectOrchestrator: ReconnectOrchestrator,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.controlMessageHandler = controlMessageHandler;
    this.businessMessageHandler = businessMessageHandler;
    this.transport = transport;
    this.heartbeatLoop = heartbeatLoop;
    this.reconnectOrchestrator = reconnectOrchestrator;
    this.context = context;
    this.state = state;
  }

  async route(event: { data: string | ArrayBuffer | Blob | Uint8Array }): Promise<void> {
    const text = await this.decodeMessageData(event.data);
    if (text === null) {
      return;
    }
    const frameBytes = Buffer.byteLength(text, 'utf8');
    this.context.telemetry.logRawFrame('onMessage', text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.context.logger?.debug?.('gateway.message.ignored_non_json', {
        payloadLength: text.length,
        frameBytes,
      });
      return;
    }

    const { messageType, gatewayMessageId } = this.context.telemetry.markReceived(parsed, frameBytes);
    this.context.sink.emitInbound(parsed);

    if (messageType === REGISTER_OK_MESSAGE_TYPE || messageType === REGISTER_REJECTED_MESSAGE_TYPE) {
      this.handleControlMessage(parsed);
      return;
    }

    const command = this.businessMessageHandler.handle(parsed, this.state.getState());
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

  private handleControlMessage(message: unknown): void {
    const command = this.controlMessageHandler.handle(message, this.state.getState(), this.state.isManuallyDisconnected());

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

  private async decodeMessageData(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string | null> {
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return await data.text();
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    return null;
  }
}
