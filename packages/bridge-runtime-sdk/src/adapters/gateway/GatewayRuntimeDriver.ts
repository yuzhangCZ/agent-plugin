import { GatewayClientStatus, type GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';

import type {
  BridgeGatewayHostConfig,
  BridgeGatewayHostConnection,
  BridgeGatewayLogger,
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
 * gateway runtime 主连接驱动适配器。
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

  async disconnect(): Promise<void> {
    try {
      await this.currentClient?.disconnect();
    } finally {
      this.detachClient();
    }
  }

  getStatus(): GatewayClientStatus {
    return this.currentClient?.getStatus?.() ?? GatewayClientStatus.closed();
  }

  send(message: GatewayUplinkBusinessMessage): void {
    if (!this.currentClient) {
      throw new Error('gateway_client_not_connected');
    }
    this.currentClient.send(message);
  }

  isReady(): boolean {
    return this.getStatus().isReady();
  }

  private attachClient(client: BridgeGatewayHostConnection): void {
    if (this.currentClient === client && this.detachGatewayObservers) {
      return;
    }
    this.detachGatewayObservers?.();
    this.currentClient = client;
    this.options.onGatewayConnectionCreated?.(client);
    this.detachGatewayObservers = attachGatewayRuntimeObservers(client, {
      onStatusChange: (status) => {
        this.options.observation.gatewayStateChanged(this.formatGatewayState(status), Date.now());
        this.handlers?.onGatewayStatusChanged(status);
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
    });
  }

  private formatGatewayState(status: GatewayClientStatus): string {
    if (status.isReady()) {
      return 'ready';
    }
    if (status.isReconnecting()) {
      return 'reconnecting';
    }
    if (status.isConnecting()) {
      return 'connecting';
    }
    return 'closed';
  }

  private detachClient(): void {
    this.detachGatewayObservers?.();
    this.detachGatewayObservers = null;
    this.currentClient = null;
  }
}
