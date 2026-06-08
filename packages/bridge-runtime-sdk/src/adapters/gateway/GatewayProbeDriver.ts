import type {
  BridgeGatewayHostConfig,
  BridgeGatewayHostConnection,
  BridgeGatewayLogger,
  BridgeGatewayProbeResult,
} from '../../infrastructure/gateway/gateway-host.ts';
import type { GatewayProbeDriver as GatewayProbeDriverPort } from '../../application/ports/gateway-runtime-driver.ts';
import type { RuntimeObservation } from '../../application/runtime-observation/index.ts';
import {
  createDefaultBridgeGatewayHostConnection,
  normalizeBridgeGatewayHostConfig,
} from '../../infrastructure/gateway/gateway-host.ts';

interface GatewayProbeDriverOptions {
  gatewayHost: BridgeGatewayHostConfig;
  logger?: BridgeGatewayLogger;
  debug?: boolean;
  observation: RuntimeObservation;
  connectionFactory?: (config: BridgeGatewayHostConfig) => BridgeGatewayHostConnection;
}

interface GatewayProbeInput {
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

/**
 * gateway 临时探测驱动适配器。
 * @remarks probe 使用旁路连接，不 attach runtime observers，也不持有主连接状态。
 */
export class GatewayProbeDriver implements GatewayProbeDriverPort {
  private readonly options: GatewayProbeDriverOptions;
  private readonly normalizedGatewayHost;

  constructor(options: GatewayProbeDriverOptions) {
    this.options = options;
    this.normalizedGatewayHost = normalizeBridgeGatewayHostConfig(options.gatewayHost, {
      logger: options.logger,
      debug: options.debug,
    });
  }

  probe(input: { timeoutMs: number; abortSignal?: AbortSignal }): Promise<BridgeGatewayProbeResult> {
    return this.probeGatewayHost(input);
  }

  // eslint-disable-next-line max-lines-per-function -- probe 需要在同一闭包中统一管理 settled、timeout 和连接清理。
  private async probeGatewayHost(input: GatewayProbeInput): Promise<BridgeGatewayProbeResult> {
    const now = Date.now;
    const startedAt = now();
    const gatewayHost = this.normalizedGatewayHost;

    this.options.observation.gatewayProbeRequested(gatewayHost.url, input.timeoutMs);

    if (input.abortSignal?.aborted) {
      const result = this.createCancelledResult(startedAt, now, input.abortSignal);
      this.recordProbeCompleted(result);
      return result;
    }

    let connection: BridgeGatewayHostConnection;
    try {
      connection = this.createProbeConnection();
    } catch (error) {
      this.recordProbeCompleted({
        state: 'connect_error',
        latencyMs: this.elapsedMs(startedAt, now),
        reason: this.normalizeErrorMessage(error),
      });
      throw error;
    }

    return await new Promise((resolve) => {
      let settled = false;

      const finish = (result: BridgeGatewayProbeResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        input.abortSignal?.removeEventListener('abort', onAbort);
        this.recordProbeCompleted(result);
        try {
          connection.disconnect();
        } catch {
          // ignore disconnect failures in probe teardown
        }
        resolve(result);
      };

      const onAbort = () => {
        const result = this.createCancelledResult(startedAt, now, input.abortSignal);
        finish(result);
      };

      input.abortSignal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        const result = {
          state: 'timeout',
          latencyMs: this.elapsedMs(startedAt, now),
          reason: 'probe timed out before READY',
        } satisfies BridgeGatewayProbeResult;
        finish(result);
      }, input.timeoutMs);

      connection.on('stateChange', (state) => {
        if (settled) {
          return;
        }
        if (state === 'READY') {
          const result = {
            state: 'ready',
            latencyMs: this.elapsedMs(startedAt, now),
            reason: 'probe_connected',
          } satisfies BridgeGatewayProbeResult;
          finish(result);
        }
      });

      connection.on('error', (error) => {
        if (settled) {
          return;
        }
        finish(this.handleConnectFailure(startedAt, now, error));
      });

      try {
        connection.connect().catch((error) => {
          if (settled) {
            return;
          }
          finish(this.handleConnectFailure(startedAt, now, error));
        });
      } catch (error) {
        finish(this.handleConnectFailure(startedAt, now, error));
      }
    });
  }

  private recordProbeCompleted(result: BridgeGatewayProbeResult): void {
    this.options.observation.gatewayProbeCompleted(
      this.normalizedGatewayHost.url,
      result.state,
      result.latencyMs,
      result.reason,
    );
  }

  private createProbeConnection(): BridgeGatewayHostConnection {
    return this.options.connectionFactory?.(this.options.gatewayHost)
      ?? createDefaultBridgeGatewayHostConnection(this.normalizedGatewayHost);
  }

  private createCancelledResult(
    startedAt: number,
    now: () => number,
    abortSignal: AbortSignal | undefined,
  ): BridgeGatewayProbeResult {
    return {
      state: 'cancelled',
      latencyMs: this.elapsedMs(startedAt, now),
      reason: this.toCancelledReason(abortSignal),
    };
  }

  private handleConnectFailure(
    startedAt: number,
    now: () => number,
    error: unknown,
  ): BridgeGatewayProbeResult {
    const message = this.normalizeErrorMessage(error);
    const result = {
      state: this.isRejectedProbeError(message) ? 'rejected' : 'connect_error',
      latencyMs: this.elapsedMs(startedAt, now),
      reason: message,
    } satisfies BridgeGatewayProbeResult;
    return result;
  }

  private elapsedMs(startedAt: number, now: () => number): number {
    return Math.max(0, now() - startedAt);
  }

  private isRejectedProbeError(message: string): boolean {
    return message !== 'gateway_websocket_error' && message !== 'gateway_not_connected';
  }

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (
      typeof error === 'object'
      && error !== null
      && 'message' in error
      && typeof (error as { message?: unknown }).message === 'string'
    ) {
      return (error as { message: string }).message;
    }
    return String(error);
  }

  private toCancelledReason(abortSignal: AbortSignal | undefined): string {
    const reason = abortSignal?.reason;
    if (reason instanceof Error) {
      return reason.message;
    }
    if (typeof reason === 'string') {
      return reason;
    }
    return 'probe_cancelled_for_runtime_lifecycle';
  }
}
