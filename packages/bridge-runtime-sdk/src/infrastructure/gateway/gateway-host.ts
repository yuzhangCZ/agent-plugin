import {
  createGatewayClientForHost,
  type GatewayClientHostConfig,
  resolveGatewayClientHostConfig,
} from '@agent-plugin/gateway-client';
import type {
  BridgeGatewayHostConfig,
  BridgeGatewayLogger,
  BridgeGatewayProbeResult,
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

export type BridgeGatewayHostState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'READY';

export interface BridgeGatewayHostError {
  code: string;
  message: string;
  retryable?: boolean;
  detail?: Record<string, unknown>;
}

export interface BridgeGatewayHostEvents {
  stateChange: (state: BridgeGatewayHostState) => void;
  inbound: (frame: unknown) => void;
  outbound: (message: unknown) => void;
  heartbeat: () => void;
  message: (message: unknown) => void;
  error: (error: BridgeGatewayHostError) => void;
}

/**
 * Bridge runtime 内部观测和驱动 gateway-client 的 adapter seam。
 * @remarks 该类型不从根入口导出，也不承诺第三方实现兼容；默认实现必须通过
 * gateway-client 的 createGatewayClientForHost 创建。
 */
export interface BridgeGatewayHostConnection {
  connect(): Promise<void>;
  disconnect(): void;
  send(message: unknown): void;
  isConnected(): boolean;
  getState(): BridgeGatewayHostState;
  getStatus(): { isReady(): boolean };
  on<E extends keyof BridgeGatewayHostEvents>(event: E, listener: BridgeGatewayHostEvents[E]): this;
}

export interface BridgeGatewayProbeInput {
  gatewayHost: InternalBridgeGatewayHostConfig;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

function elapsedMs(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function isRejectedProbeError(message: string): boolean {
  return message !== 'gateway_websocket_error' && message !== 'gateway_not_connected';
}

function logInfo(logger: BridgeGatewayLogger | undefined, message: string, meta: Record<string, unknown>): void {
  logger?.info?.(message, meta);
}

function logWarn(logger: BridgeGatewayLogger | undefined, message: string, meta: Record<string, unknown>): void {
  logger?.warn?.(message, meta);
}

function logError(logger: BridgeGatewayLogger | undefined, message: string, meta: Record<string, unknown>): void {
  logger?.error?.(message, meta);
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

export async function probeBridgeGatewayHost(
  input: BridgeGatewayProbeInput,
  deps: {
    connectionFactory?: (config: InternalBridgeGatewayHostConfig) => BridgeGatewayHostConnection;
    now?: () => number;
  } = {},
): Promise<BridgeGatewayProbeResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { gatewayHost, timeoutMs } = input;
  const logger = gatewayHost.logger;

  logInfo(logger, 'probe.requested', {
    connectionKey: gatewayHost.connectionKey,
    gatewayUrl: gatewayHost.url,
    timeoutMs,
  });

  const connection = deps.connectionFactory?.(gatewayHost) ?? createDefaultBridgeGatewayHostConnection(gatewayHost);

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (result: BridgeGatewayProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.abortSignal?.removeEventListener('abort', onAbort);
      try {
        connection.disconnect();
      } catch {
        // ignore disconnect failures in probe teardown
      }
      resolve(result);
    };

    const onAbort = () => {
      const result = {
        state: 'cancelled',
        latencyMs: elapsedMs(startedAt, now),
        reason: 'probe_cancelled_for_runtime_start',
      } satisfies BridgeGatewayProbeResult;
      logInfo(logger, 'probe.connect.cancelled_for_runtime', {
        connectionKey: gatewayHost.connectionKey,
        gatewayUrl: gatewayHost.url,
        latencyMs: result.latencyMs,
        reason: result.reason,
      });
      finish(result);
    };

    input.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      const result = {
        state: 'timeout',
        latencyMs: elapsedMs(startedAt, now),
        reason: 'probe timed out before READY',
      } satisfies BridgeGatewayProbeResult;
      logWarn(logger, 'probe.connect.timeout', {
        connectionKey: gatewayHost.connectionKey,
        gatewayUrl: gatewayHost.url,
        latencyMs: result.latencyMs,
        reason: result.reason,
      });
      finish(result);
    }, timeoutMs);

    logInfo(logger, 'probe.connect.started', {
      connectionKey: gatewayHost.connectionKey,
      gatewayUrl: gatewayHost.url,
      timeoutMs,
    });

    connection.on('stateChange', (state) => {
      if (settled) {
        return;
      }
      if (state === 'READY') {
        const result = {
          state: 'ready',
          latencyMs: elapsedMs(startedAt, now),
          reason: 'probe_connected',
        } satisfies BridgeGatewayProbeResult;
        logInfo(logger, 'probe.connect.ready', {
          connectionKey: gatewayHost.connectionKey,
          gatewayUrl: gatewayHost.url,
          latencyMs: result.latencyMs,
          reason: result.reason,
        });
        finish(result);
        return;
      }
    });

    connection.on('error', (error) => {
      if (settled) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error.message ?? error);
      const result = {
        state: isRejectedProbeError(message) ? 'rejected' : 'connect_error',
        latencyMs: elapsedMs(startedAt, now),
        reason: message,
      } satisfies BridgeGatewayProbeResult;
      const log = result.state === 'rejected' ? logWarn : logError;
      log(logger, result.state === 'rejected' ? 'probe.connect.rejected' : 'probe.connect.error', {
        connectionKey: gatewayHost.connectionKey,
        gatewayUrl: gatewayHost.url,
        latencyMs: result.latencyMs,
        reason: result.reason,
      });
      finish(result);
    });

    connection.connect().catch((error) => {
      if (settled) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        state: isRejectedProbeError(message) ? 'rejected' : 'connect_error',
        latencyMs: elapsedMs(startedAt, now),
        reason: message,
      } satisfies BridgeGatewayProbeResult;
      const log = result.state === 'rejected' ? logWarn : logError;
      log(logger, result.state === 'rejected' ? 'probe.connect.rejected' : 'probe.connect.error', {
        connectionKey: gatewayHost.connectionKey,
        gatewayUrl: gatewayHost.url,
        latencyMs: result.latencyMs,
        reason: result.reason,
      });
      finish(result);
    });
  });
}
