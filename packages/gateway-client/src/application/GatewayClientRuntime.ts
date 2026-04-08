import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import type { GatewayTransport } from '../ports/GatewayTransport.ts';
import type { HeartbeatScheduler } from '../ports/HeartbeatScheduler.ts';
import type { ReconnectPolicy } from '../ports/ReconnectPolicy.ts';
import type { ReconnectScheduler } from '../ports/ReconnectScheduler.ts';
import type { GatewayWireCodec } from '../ports/GatewayWireCodec.ts';
import type { GatewaySendContext } from '../domain/send-context.ts';
import type { GatewayClientState } from '../domain/state.ts';
import { GATEWAY_CLIENT_STATE } from '../domain/state.ts';
import { BusinessMessageHandler } from './handlers/BusinessMessageHandler.ts';
import { ControlMessageHandler } from './handlers/ControlMessageHandler.ts';
import { GatewayClientTelemetry } from './telemetry/GatewayClientTelemetry.ts';
import type { GatewayRuntimeContext, GatewayRuntimeSink, GatewayRuntimeStatePort } from './runtime/GatewayRuntimeContracts.ts';
import { ConnectSession } from './runtime/ConnectSession.ts';
import { HeartbeatLoop } from './runtime/HeartbeatLoop.ts';
import { InboundFrameRouter } from './runtime/InboundFrameRouter.ts';
import { OutboundSender } from './runtime/OutboundSender.ts';
import { ReconnectOrchestrator } from './runtime/ReconnectOrchestrator.ts';
import type { AkSkAuthPayload } from '../ports/GatewayAuthProvider.ts';

export interface GatewayClientRuntimeDependencies {
  transport: GatewayTransport;
  heartbeatScheduler: HeartbeatScheduler;
  reconnectScheduler: ReconnectScheduler;
  reconnectEnabled: boolean;
  reconnectPolicy: ReconnectPolicy;
  wireCodec: GatewayWireCodec;
  controlMessageHandler: ControlMessageHandler;
  businessMessageHandler: BusinessMessageHandler;
  authSubprotocolBuilder: (payload: AkSkAuthPayload) => string;
}

// GatewayClientRuntime 是唯一运行时编排器，只协调状态机与协作对象。
export class GatewayClientRuntime implements GatewayRuntimeStatePort {
  private readonly options: GatewayClientOptions;
  private readonly transport: GatewayTransport;
  private readonly context: GatewayRuntimeContext;
  private readonly outboundSender: OutboundSender;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly reconnectOrchestrator: ReconnectOrchestrator;
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
      dependencies.wireCodec,
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
    this.inboundFrameRouter = new InboundFrameRouter(
      dependencies.controlMessageHandler,
      dependencies.businessMessageHandler,
      dependencies.transport,
      this.heartbeatLoop,
      this.reconnectOrchestrator,
      this.context,
      this,
    );
    this.connectSession = new ConnectSession(
      dependencies.transport,
      this.outboundSender,
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

  send(message: unknown, logContext?: GatewaySendContext): void {
    this.outboundSender.send(message, logContext);
  }
}
