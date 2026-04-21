import type { BusinessMessageHandler } from '../handlers/BusinessMessageHandler.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import type { InboundClassificationResult } from './InboundFrameClassifier.ts';
import { buildProtocolViolationError } from './buildProtocolViolationError.ts';

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
 * 运行期入站路由器。
 * @remarks 只处理 READY gating 与业务帧分发，不再承载握手裁决或 transport 生命周期动作。
 */
export class InboundFrameRouter {
  private readonly businessMessageHandler: BusinessMessageHandler;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    businessMessageHandler: BusinessMessageHandler,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.businessMessageHandler = businessMessageHandler;
    this.context = context;
    this.state = state;
  }

  async route(classification: Exclude<InboundClassificationResult, { kind: 'handshake-control' | 'invalid-handshake' }>): Promise<void> {
    if (classification.kind === 'nonparsed') {
      this.context.sink.emitInbound(classification.frame);
      return;
    }

    if (classification.kind === 'invalid-business') {
      const error = this.buildBusinessProtocolViolation(classification.frame);
      this.context.logger?.error?.('gateway.business.validation_failed', {
        ...error.details,
        failClosed: false,
      });
      this.context.sink.emitError(error);
      return;
    }

    const command = this.businessMessageHandler.handle(classification.frame.message, this.state.getState());
    if (command.kind === 'ignored-not-ready') {
      logDebug(this.context.logger, 'gateway.message.received_not_ready', {
        state: this.state.getState(),
        messageType: classification.messageType,
        gatewayMessageId: classification.gatewayMessageId,
      });
      return;
    }

    this.context.sink.emitMessage(command.message);
  }

  private buildBusinessProtocolViolation(
    inboundFrame: Extract<InboundClassificationResult, { kind: 'invalid-business' }>['frame'],
  ): GatewayClientError {
    return buildProtocolViolationError(inboundFrame);
  }
}
