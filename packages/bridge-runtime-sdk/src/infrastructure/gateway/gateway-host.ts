import {
  createGatewayClientForHost,
  type GatewayClientStatus,
  type GatewayClientHostConfig,
  resolveGatewayClientHostConfig,
} from '@agent-plugin/gateway-client';
import type {
  BridgeGatewayHostConfig,
  BridgeGatewayLogger,
} from '../../public-contract.ts';
import { resolvePackageVersion } from '../../packageVersion.ts';

export type {
  BridgeGatewayChannel,
  BridgeGatewayHostConfig,
  BridgeGatewayLogger,
  BridgeGatewayProbeResult,
  BridgeGatewayProbeState,
} from '../../public-contract.ts';

interface InternalBridgeGatewayHostConfig extends GatewayClientHostConfig {
  url: string;
  connectionKey: string;
  debug?: boolean;
  abortSignal?: AbortSignal;
  logger?: BridgeGatewayLogger;
}

export interface BridgeGatewayHostEvents {
  statusChange: (status: GatewayClientStatus) => void;
  inbound: (frame: unknown) => void;
  outbound: (message: unknown) => void;
  heartbeat: () => void;
  message: (message: unknown) => void;
}

/**
 * Bridge runtime 内部观测和驱动 gateway-client 的 adapter seam。
 * @remarks 该类型不从根入口导出，也不承诺第三方实现兼容；默认实现必须通过
 * gateway-client 的 createGatewayClientForHost 创建。
 */
export interface BridgeGatewayHostConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: unknown): void;
  isConnected(): boolean;
  getStatus(): GatewayClientStatus;
  on<E extends keyof BridgeGatewayHostEvents>(event: E, listener: BridgeGatewayHostEvents[E]): this;
}

export function createDefaultBridgeGatewayHostConnection(
  config: InternalBridgeGatewayHostConfig,
): BridgeGatewayHostConnection {
  return createGatewayClientForHost(config, {
    debug: config.debug,
    abortSignal: config.abortSignal,
    logger: config.logger,
  }) as BridgeGatewayHostConnection;
}

export function buildBridgeGatewayConnectionKey(gatewayHost: BridgeGatewayHostConfig): string {
  return `${gatewayHost.url}:${gatewayHost.auth.ak}`;
}

function toGatewayClientHostConfig(gatewayHost: BridgeGatewayHostConfig): GatewayClientHostConfig {
  return {
    ...gatewayHost,
    register: {
      toolType: gatewayHost.register.channel,
      toolVersion: gatewayHost.register.toolVersion,
      ...(gatewayHost.register.pluginVersion ? { pluginVersion: gatewayHost.register.pluginVersion } : {}),
    },
  };
}

export function normalizeBridgeGatewayHostConfig(
  gatewayHost: BridgeGatewayHostConfig,
  options: {
    logger?: BridgeGatewayLogger;
    debug?: boolean;
    abortSignal?: AbortSignal;
  } = {},
): InternalBridgeGatewayHostConfig {
  const resolvedGatewayHost = resolveGatewayClientHostConfig(toGatewayClientHostConfig(gatewayHost));
  const sdkVersion = resolvePackageVersion();

  return {
    ...resolvedGatewayHost,
    register: {
      ...resolvedGatewayHost.register,
      ...(sdkVersion ? { sdkVersion } : {}),
    },
    connectionKey: buildBridgeGatewayConnectionKey(gatewayHost),
    debug: options.debug,
    abortSignal: options.abortSignal,
    logger: options.logger,
  };
}
