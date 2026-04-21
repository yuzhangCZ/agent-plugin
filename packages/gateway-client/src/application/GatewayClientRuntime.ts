import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import type { GatewayTransport } from '../ports/GatewayTransport.ts';
import type { HeartbeatScheduler } from '../ports/HeartbeatScheduler.ts';
import type { ReconnectPolicy } from '../ports/ReconnectPolicy.ts';
import type { ReconnectScheduler } from '../ports/ReconnectScheduler.ts';
import type { GatewayWireCodec } from '../ports/GatewayWireCodec.ts';
import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientState } from '../domain/state.ts';
import { GATEWAY_CLIENT_STATE } from '../domain/state.ts';
import type { GatewaySendPayload } from '../ports/GatewayClientMessages.ts';
import { BusinessMessageHandler } from './handlers/BusinessMessageHandler.ts';
import type { OutboundProtocolGate } from './protocol/OutboundProtocolGate.ts';
import { GatewayClientTelemetry } from './telemetry/GatewayClientTelemetry.ts';
import type { GatewayRuntimeContext, GatewayRuntimeSink, GatewayRuntimeStatePort } from './runtime/GatewayRuntimeContracts.ts';
import { ConnectSession } from './runtime/ConnectSession.ts';
import { HeartbeatLoop } from './runtime/HeartbeatLoop.ts';
import { HandshakeFrameProcessor } from './runtime/HandshakeFrameProcessor.ts';
import { InboundFrameClassifier } from './runtime/InboundFrameClassifier.ts';
import { InboundFrameRouter } from './runtime/InboundFrameRouter.ts';
import { OutboundSender } from './runtime/OutboundSender.ts';
import { ReconnectOrchestrator } from './runtime/ReconnectOrchestrator.ts';
import type { AkSkAuthPayload } from '../ports/GatewayAuthProvider.ts';

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
  private manuallyDisconnected = false;
  private state: GatewayClientState = GATEWAY_CLIENT_STATE.DISCONNECTED;

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
      reconnectInvoker: () => this.connect(),
      authSubprotocolBuilder: dependencies.authSubprotocolBuilder,
    };

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

  setReconnectInvoker(invoker: () => Promise<void>): void {
    this.context.reconnectInvoker = invoker;
  }

  getState(): GatewayClientState {
    return this.state;
  }

  setState(next: GatewayClientState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.context.sink.emitStateChange(next);
  }

  isConnected(): boolean {
    return this.transport.isOpen();
  }

  isManuallyDisconnected(): boolean {
    return this.manuallyDisconnected;
  }

  setManuallyDisconnected(value: boolean): void {
    this.manuallyDisconnected = value;
  }

  connect(): Promise<void> {
    return this.connectSession.connect();
  }

  disconnect(): void {
    this.context.logger?.info?.('gateway.disconnect.requested', { state: this.state });
    this.setManuallyDisconnected(true);
    this.reconnectOrchestrator.reset();
    this.transport.close();
    this.heartbeatLoop.stop();
    this.reconnectOrchestrator.stop();
    this.setState(GATEWAY_CLIENT_STATE.DISCONNECTED);
  }

  send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
    this.outboundSender.send(message, logContext);
  }
}
