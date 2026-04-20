import { REGISTER_MESSAGE_TYPE } from '@agent-plugin/gateway-schema';

import type { GatewayTransport } from '../../ports/GatewayTransport.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import { extractWebSocketErrorDetails, getErrorDetails } from '../telemetry/error-detail-mapper.ts';
import { InboundFrameRouter } from './InboundFrameRouter.ts';
import { OutboundSender } from './OutboundSender.ts';
import { ReconnectOrchestrator } from './ReconnectOrchestrator.ts';
import { HeartbeatLoop } from './HeartbeatLoop.ts';

const GATEWAY_REJECTION_CLOSE_CODES = new Set([4403, 4408, 4409]);

type GatewayCloseEventLike = Partial<CloseEvent> & {
  code?: unknown;
  reason?: unknown;
  wasClean?: unknown;
};

function isGatewayRejectedCloseCode(code: unknown): boolean {
  return typeof code === 'number' && Number.isFinite(code) && GATEWAY_REJECTION_CLOSE_CODES.has(code);
}

/**
 * 单次连接会话编排器。
 * @remarks connect/open/close/error 的关键决策与日志在此集中收口。
 */
export class ConnectSession {
  private readonly transport: GatewayTransport;
  private readonly outboundSender: OutboundSender;
  private readonly inboundFrameRouter: InboundFrameRouter;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    transport: GatewayTransport,
    outboundSender: OutboundSender,
    inboundFrameRouter: InboundFrameRouter,
    reconnectOrchestrator: ReconnectOrchestrator,
    heartbeatLoop: HeartbeatLoop,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.transport = transport;
    this.outboundSender = outboundSender;
    this.inboundFrameRouter = inboundFrameRouter;
    this.reconnectOrchestrator = reconnectOrchestrator;
    this.heartbeatLoop = heartbeatLoop;
    this.context = context;
    this.state = state;
  }

  async connect(): Promise<void> {
    this.context.logger?.info?.('gateway.connect.started', {
      url: this.context.options.url,
      state: this.state.getState(),
    });
    if (this.context.abortSignal?.aborted) {
      this.state.setManuallyDisconnected(true);
      this.state.setState('DISCONNECTED');
      this.context.logger?.warn?.('gateway.connect.aborted_precheck');
      throw new GatewayClientError({
        code: 'GATEWAY_CONNECT_ABORTED',
        category: 'state',
        retryable: false,
        message: 'gateway_connection_aborted',
      });
    }

    this.context.telemetry.reset();
    this.state.setState('CONNECTING');

    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;

      const finalizeResolve = () => {
        if (settled) return;
        settled = true;
        cleanupAbortListener();
        resolve();
      };

      const finalizeReject = (error: GatewayClientError) => {
        if (settled) return;
        settled = true;
        cleanupAbortListener();
        reject(error);
      };

      const abortHandler = () => {
        this.state.setManuallyDisconnected(true);
        this.transport.close();
        this.heartbeatLoop.stop();
        this.reconnectOrchestrator.stop();
        this.state.setState('DISCONNECTED');
        this.context.logger?.warn?.('gateway.connect.aborted');
        finalizeReject(new GatewayClientError({
          code: 'GATEWAY_CONNECT_ABORTED',
          category: 'state',
          retryable: false,
          message: 'gateway_connection_aborted',
        }));
      };

      const cleanupAbortListener = () => {
        this.context.abortSignal?.removeEventListener('abort', abortHandler);
      };

      if (this.context.abortSignal) {
        this.context.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        const url = new URL(this.context.options.url);
        const authPayload = this.context.options.authPayloadProvider?.();
        const protocols = authPayload ? [this.context.authSubprotocolBuilder(authPayload)] : undefined;
        this.state.setManuallyDisconnected(false);
        this.transport.open({
          url: url.toString(),
          protocols,
          onOpen: (event) => {
            opened = true;
            this.context.telemetry.logRawFrame('onOpen', event);
            this.context.logger?.info?.('gateway.open');
            this.state.setState('CONNECTED');
            try {
              this.outboundSender.sendInternalControl(this.context.options.registerMessage);
              this.context.logger?.info?.('gateway.register.sent', {
                toolType: this.context.options.registerMessage.toolType,
                toolVersion: this.context.options.registerMessage.toolVersion,
              });
              finalizeResolve();
            } catch (error) {
              const clientError = this.toClientError(error, 'GATEWAY_PROTOCOL_VIOLATION', 'protocol', false);
              this.context.logger?.error?.('gateway.register.failed', {
                error: clientError.message,
                ...getErrorDetails(clientError),
              });
              this.heartbeatLoop.stop();
              this.reconnectOrchestrator.stop();
              this.transport.close();
              this.state.setState('DISCONNECTED');
              finalizeReject(clientError);
            }
          },
          onClose: (event) => {
            const close = event as GatewayCloseEventLike | undefined;
            const rejected = isGatewayRejectedCloseCode(close?.code);
            // reconnectPlanned 必须与 composition root 已解析的 reconnectEnabled 保持一致，
            // 这样 close 日志、调度前置判断和真正的重连策略才不会漂移。
            const reconnectPlanned =
              opened
              && !this.state.isManuallyDisconnected()
              && !this.context.abortSignal?.aborted
              && !rejected
              && this.context.reconnectEnabled;
            this.context.telemetry.logClose({
              opened,
              manuallyDisconnected: this.state.isManuallyDisconnected(),
              aborted: !!this.context.abortSignal?.aborted,
              rejected,
              reconnectPlanned,
              code: close?.code,
              reason: close?.reason,
              wasClean: close?.wasClean,
            });
            if (!opened) {
              finalizeReject(new GatewayClientError({
                code: 'GATEWAY_CLOSED_BEFORE_OPEN',
                category: 'transport',
                retryable: true,
                message: 'gateway_websocket_closed_before_open',
                details: {
                  code: close?.code,
                  reason: close?.reason,
                },
              }));
            }
            this.heartbeatLoop.stop();
            this.reconnectOrchestrator.stop();
            this.state.setState('DISCONNECTED');
            if (rejected) {
              this.context.logger?.warn?.('gateway.close.rejected', {
                code: close?.code,
                reason: close?.reason,
                rejected: true,
              });
              return;
            }
            if (reconnectPlanned) {
              this.reconnectOrchestrator.scheduleReconnect();
            }
          },
          onError: (event) => {
            this.context.telemetry.logRawFrame('onError', event);
            const error = new GatewayClientError({
              code: 'GATEWAY_WEBSOCKET_ERROR',
              category: 'transport',
              retryable: true,
              message: 'gateway_websocket_error',
              details: extractWebSocketErrorDetails(event),
              cause: event,
            });
            this.context.logger?.error?.('gateway.error', {
              error: error.message,
              state: this.state.getState(),
              ...error.details,
            });
            this.context.sink.emitError(error);
            if (this.state.getState() !== 'DISCONNECTED') {
              this.state.setState('DISCONNECTED');
            }
            finalizeReject(error);
          },
          onMessage: (event) => {
            this.inboundFrameRouter.route(event).catch((error) => {
              this.context.sink.emitError(this.toClientError(error, 'GATEWAY_PROTOCOL_VIOLATION', 'protocol', false));
            });
          },
        });
      } catch (error) {
        const clientError = this.toClientError(error, 'GATEWAY_WEBSOCKET_ERROR', 'transport', true);
        this.context.logger?.error?.('gateway.connect.failed', {
          error: clientError.message,
          ...getErrorDetails(clientError),
        });
        finalizeReject(clientError);
      }
    });
  }

  private toClientError(
    error: unknown,
    code: GatewayClientError['code'],
    category: GatewayClientError['category'],
    retryable: boolean,
  ): GatewayClientError {
    if (error instanceof GatewayClientError) {
      return error;
    }
    return new GatewayClientError({
      code,
      category,
      retryable,
      message: error instanceof Error ? error.message : String(error),
      details: getErrorDetails(error),
      cause: error,
    });
  }
}
