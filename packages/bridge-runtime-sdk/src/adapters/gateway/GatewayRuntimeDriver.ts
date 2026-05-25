import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';

import type {
  BridgeGatewayHostConfig,
  BridgeGatewayHostConnection,
  BridgeGatewayLogger,
  BridgeGatewayProbeResult,
} from '../../infrastructure/gateway/gateway-host.ts';
import type {
  GatewayRuntimeDriver as GatewayRuntimeDriverPort,
  GatewayRuntimeDriverHandlers,
} from '../../application/ports/gateway-runtime-driver.ts';
import type { InboundPolicy } from '../../application/ports/inbound-policy.ts';
import type { RuntimeObservation } from '../../application/runtime-observation/index.ts';
import {
  createDefaultBridgeGatewayHostConnection,
  normalizeBridgeGatewayHostConfig,
  probeBridgeGatewayHost,
} from '../../infrastructure/gateway/gateway-host.ts';
import { attachGatewayRuntimeObservers } from './gateway-runtime-observers.ts';

interface GatewayRuntimeDriverOptions {
  gatewayHost: BridgeGatewayHostConfig;
  logger?: BridgeGatewayLogger;
  debug?: boolean;
  observation: RuntimeObservation;
  inboundPolicy: InboundPolicy;
  onTelemetryUpdated?: () => void;
  connectionFactory?: (config: BridgeGatewayHostConfig) => BridgeGatewayHostConnection;
  onGatewayConnectionCreated?: (connection: BridgeGatewayHostConnection) => void;
}

/**
 * gateway connection / probe 驱动适配器。
 */
export class GatewayRuntimeDriver implements GatewayRuntimeDriverPort {
  private readonly options: GatewayRuntimeDriverOptions;
  private readonly normalizedGatewayHost;
  private currentClient: BridgeGatewayHostConnection | null = null;
  private detachGatewayObservers: (() => void) | null = null;
  private handlers: GatewayRuntimeDriverHandlers | null = null;

  constructor(options: GatewayRuntimeDriverOptions) {
    this.options = options;
    this.normalizedGatewayHost = normalizeBridgeGatewayHostConfig(options.gatewayHost, {
      logger: options.logger,
      debug: options.debug,
    });
  }

  attach(handlers: GatewayRuntimeDriverHandlers): void {
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    const client =
      this.options.connectionFactory?.(this.options.gatewayHost)
      ?? createDefaultBridgeGatewayHostConnection(this.normalizedGatewayHost);
    this.attachClient(client);
    await client.connect();
  }

  disconnect(): void {
    this.currentClient?.disconnect();
    this.detachClient();
  }

  send(message: GatewayUplinkBusinessMessage): void {
    if (!this.currentClient) {
      throw new Error('gateway_client_not_connected');
    }
    this.currentClient.send(message);
  }

  probe(input: { timeoutMs: number; abortSignal?: AbortSignal }): Promise<BridgeGatewayProbeResult> {
    return probeBridgeGatewayHost(
      {
        gatewayHost: this.normalizedGatewayHost,
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      },
      {
        connectionFactory: this.options.connectionFactory
          ? () => this.options.connectionFactory!(this.options.gatewayHost)
          : undefined,
      },
    );
  }

  isReady(): boolean {
    const gatewayStatus = this.currentClient?.getStatus?.();
    return typeof gatewayStatus?.isReady === 'function' ? gatewayStatus.isReady() : false;
  }

  private attachClient(client: BridgeGatewayHostConnection): void {
    if (this.currentClient === client && this.detachGatewayObservers) {
      return;
    }
    this.detachGatewayObservers?.();
    this.currentClient = client;
    this.options.onGatewayConnectionCreated?.(client);
    this.detachGatewayObservers = attachGatewayRuntimeObservers(client, {
      onStateChange: (state) => {
        this.options.observation.gatewayStateChanged(state, Date.now());
        this.handlers?.onGatewayStateChanged(state);
        this.options.onTelemetryUpdated?.();
      },
      onInbound: (frame: GatewayInboundFrame) => {
        this.options.observation.gatewayInboundActivity(Date.now());
        this.options.inboundPolicy.handle(frame, {
          isGatewayReady: this.isReady(),
        });
        this.options.onTelemetryUpdated?.();
      },
      onOutbound: () => {
        this.options.observation.gatewayOutboundActivity(Date.now());
        this.options.onTelemetryUpdated?.();
      },
      onHeartbeat: () => {
        this.options.observation.gatewayHeartbeatActivity(Date.now());
        this.options.onTelemetryUpdated?.();
      },
      onMessage: (message) => {
        this.handlers?.onBusinessMessage(message);
        this.options.onTelemetryUpdated?.();
      },
      onError: (error) => {
        if (!error.retryable) {
          this.handlers?.onNonRetryableError(error);
        }
        this.options.onTelemetryUpdated?.();
      },
    });
  }

  private detachClient(): void {
    this.detachGatewayObservers?.();
    this.detachGatewayObservers = null;
    this.currentClient = null;
  }
}
