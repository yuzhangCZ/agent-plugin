import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import type { GatewayTransport } from '../ports/GatewayTransport.ts';
import type { HeartbeatScheduler } from '../ports/HeartbeatScheduler.ts';
import type { ReconnectPolicy } from '../ports/ReconnectPolicy.ts';
import type { ReconnectScheduler } from '../ports/ReconnectScheduler.ts';
import type { GatewayWireCodec } from '../ports/GatewayWireCodec.ts';
import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientStatus } from '../domain/state.ts';
import type { GatewaySendPayload } from '../ports/GatewayClientMessages.ts';
import { BusinessMessageHandler } from './handlers/BusinessMessageHandler.ts';
import type { OutboundProtocolGate } from './protocol/OutboundProtocolGate.ts';
import { GatewayClientTelemetry } from './telemetry/GatewayClientTelemetry.ts';
import type {
  GatewayRuntimeContext,
  GatewayRuntimeSink,
  GatewayRuntimeStatePort,
} from './runtime/GatewayRuntimeContracts.ts';
import { ConnectSession } from './runtime/ConnectSession.ts';
import { GatewayLifecycleState, type GatewayLifecycleSessionToken } from './runtime/GatewayLifecycleState.ts';
import { HeartbeatLoop } from './runtime/HeartbeatLoop.ts';
import { HandshakeFrameProcessor } from './runtime/HandshakeFrameProcessor.ts';
import { InboundFrameClassifier } from './runtime/InboundFrameClassifier.ts';
import { InboundFrameRouter } from './runtime/InboundFrameRouter.ts';
import { OutboundSender } from './runtime/OutboundSender.ts';
import { ReconnectOrchestrator } from './runtime/ReconnectOrchestrator.ts';
import type { AkSkAuthPayload } from '../ports/GatewayAuthProvider.ts';
import type { GatewayClientError } from '../errors/GatewayClientError.ts';

/**
 * GatewayClientRuntime 需要的依赖集合。
 */
export interface GatewayClientRuntimeDependencies {
  transport: GatewayTransport;
  heartbeatScheduler: HeartbeatScheduler;
  reconnectScheduler: ReconnectScheduler;
  reconnectEnabled: boolean;
  reconnectPolicy: ReconnectPolicy;
  wireCodec: GatewayWireCodec;
  outboundProtocolGate: OutboundProtocolGate;
  businessMessageHandler: BusinessMessageHandler;
  authSubprotocolBuilder: (payload: AkSkAuthPayload) => string;
}

/**
 * 运行时主编排器。
 * @remarks 只协调状态机与协作对象，不承载具体协议或 transport 细节。
 */
export class GatewayClientRuntime implements GatewayRuntimeStatePort {
  private readonly options: GatewayClientOptions;
  private readonly transport: GatewayTransport;
  private readonly context: GatewayRuntimeContext;
  private readonly outboundSender: OutboundSender;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
  private readonly inboundFrameClassifier: InboundFrameClassifier;
  private readonly handshakeFrameProcessor: HandshakeFrameProcessor;
  private readonly inboundFrameRouter: InboundFrameRouter;
  private readonly connectSession: ConnectSession;
  private readonly lifecycleState: GatewayLifecycleState;

  constructor(options: GatewayClientOptions, dependencies: GatewayClientRuntimeDependencies, sink: GatewayRuntimeSink) {
    this.options = options;
    this.transport = dependencies.transport;
    this.context = {
      options,
      logger: options.logger,
      telemetry: new GatewayClientTelemetry({ logger: options.logger, debug: options.debug }),
      sink,
      abortSignal: options.abortSignal,
      reconnectEnabled: dependencies.reconnectEnabled,
      authSubprotocolBuilder: dependencies.authSubprotocolBuilder,
    };
    this.lifecycleState = new GatewayLifecycleState({
      emitStatusChange: (status) => this.context.sink.emitStatusChange(status),
    });

    this.outboundSender = new OutboundSender(
      dependencies.transport,
      dependencies.outboundProtocolGate,
      this.context,
      this,
    );
    this.heartbeatLoop = new HeartbeatLoop(
      dependencies.heartbeatScheduler,
      this.outboundSender,
      this.context,
      this,
    );
    this.reconnectOrchestrator = new ReconnectOrchestrator(
      dependencies.reconnectScheduler,
      dependencies.reconnectPolicy,
      this.context,
      this,
      dependencies.reconnectEnabled,
      () => this.connectInternal(true),
    );
    this.inboundFrameClassifier = new InboundFrameClassifier(this.context, dependencies.wireCodec);
    this.handshakeFrameProcessor = new HandshakeFrameProcessor();
    this.inboundFrameRouter = new InboundFrameRouter(
      dependencies.businessMessageHandler,
      this.context,
      this,
    );
    this.connectSession = new ConnectSession(
      dependencies.transport,
      this.outboundSender,
      this.inboundFrameClassifier,
      this.handshakeFrameProcessor,
      this.inboundFrameRouter,
      this.reconnectOrchestrator,
      this.heartbeatLoop,
      this.context,
      this,
    );
  }

  getStatus(): GatewayClientStatus {
    return this.lifecycleState.getStatus();
  }

  isConnected(): boolean {
    return this.transport.isOpen();
  }

  isManuallyDisconnected(): boolean {
    return this.lifecycleState.isManuallyDisconnected();
  }

  beginConnect(input: { reconnectAttempt: boolean }): GatewayLifecycleSessionToken {
    return this.lifecycleState.beginConnect(input);
  }

  finishConnectIfCurrent(token: GatewayLifecycleSessionToken): boolean {
    return this.lifecycleState.finishConnectIfCurrent(token);
  }

  markReconnectingIfCurrent(token: GatewayLifecycleSessionToken): boolean {
    return this.lifecycleState.markReconnectingIfCurrent(token);
  }

  beginReconnectWindow(): number {
    return this.lifecycleState.beginReconnectWindow();
  }

  closeReconnectExhaustedIfCurrent(generation: number): boolean {
    return this.lifecycleState.closeReconnectExhaustedIfCurrent(generation);
  }

  isCurrentGeneration(generation: number): boolean {
    return this.lifecycleState.isCurrentGeneration(generation);
  }

  closeIfCurrent(token: GatewayLifecycleSessionToken, error: GatewayClientError): boolean {
    return this.lifecycleState.closeIfCurrent(token, error);
  }

  isCurrentSession(token: GatewayLifecycleSessionToken): boolean {
    return this.lifecycleState.isCurrentSession(token);
  }

  connect(): Promise<void> {
    return this.connectInternal(false);
  }

  async disconnect(): Promise<void> {
    this.context.logger?.info?.('gateway.disconnect.requested', {
      connection: this.getStatus().toDiagnosticFields(),
    });
    this.lifecycleState.closeManual();
    this.connectSession.cancelManualDisconnect();
    this.heartbeatLoop.stop();
    this.reconnectOrchestrator.stop();
    try {
      this.transport.close();
    } catch (error) {
      this.context.logger?.warn?.('gateway.disconnect.close_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
    this.outboundSender.send(message, logContext);
  }

  private connectInternal(reconnectAttempt: boolean): Promise<void> {
    return this.connectSession.connect({ reconnectAttempt });
  }
}
