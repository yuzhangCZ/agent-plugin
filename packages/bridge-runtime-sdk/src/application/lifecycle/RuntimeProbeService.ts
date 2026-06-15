import type { BridgeGatewayProbeResult } from '../../infrastructure/gateway/gateway-host.ts';
import { DEFAULT_PROBE_TIMEOUT_MS } from '../constants/runtime.ts';
import type { GatewayProbeDriver } from '../ports/gateway-runtime-driver.ts';
import type { BridgeRuntimeStatusSnapshot } from '../runtime.ts';
import { fromProbeFailure } from '../runtime-error-classifier.ts';

/**
 * runtime gateway 探测服务。
 * @remarks probe 使用临时连接，是 lifecycle 的旁路能力，不驱动主状态机。
 */
export class RuntimeProbeService {
  private readonly driver: GatewayProbeDriver;
  private readonly activeProbes = new Map<number, {
    abortController: AbortController;
    promise: Promise<BridgeGatewayProbeResult>;
  }>();

  constructor(driver: GatewayProbeDriver) {
    this.driver = driver;
  }

  /**
   * 取消当前临时 probe。
   * @remarks 这是 start/stop 前的旁路清理，失败不向 lifecycle 传播。
   */
  async cancelActiveProbe(): Promise<void> {
    if (this.activeProbes.size === 0) {
      return;
    }

    const activeProbes = Array.from(this.activeProbes.values());
    for (const probe of activeProbes) {
      probe.abortController.abort(new Error('probe_cancelled_for_runtime_lifecycle'));
    }
    await Promise.all(activeProbes.map((probe) => probe.promise.catch(() => undefined)));
  }

  async probe(
    status: BridgeRuntimeStatusSnapshot,
    input = { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS },
  ): Promise<BridgeGatewayProbeResult> {
    const startedAt = Date.now();
    if (status.state === 'ready') {
      return {
        state: 'ready',
        latencyMs: 0,
        reason: 'runtime_ready',
      };
    }

    if (status.state === 'starting' || status.state === 'reconnecting' || status.state === 'stopping') {
      return {
        state: 'connecting',
        latencyMs: Math.max(0, Date.now() - startedAt),
        reason: 'runtime_lifecycle_busy_probe_skipped',
      };
    }

    const activeProbe = this.activeProbes.get(input.timeoutMs);
    if (activeProbe) {
      return activeProbe.promise;
    }

    const abortController = new AbortController();
    try {
      const pendingProbe = this.driver.probe({
        timeoutMs: input.timeoutMs,
        abortSignal: abortController.signal,
      });
      const probePromise = pendingProbe.catch((error) => {
        throw fromProbeFailure(error);
      }).finally(() => {
        this.clearActiveProbe(input.timeoutMs, abortController);
      });
      this.activeProbes.set(input.timeoutMs, { abortController, promise: probePromise });
    } catch (error) {
      throw fromProbeFailure(error);
    }
    return this.activeProbes.get(input.timeoutMs)!.promise;
  }

  private clearActiveProbe(timeoutMs: number, abortController: AbortController): void {
    if (this.activeProbes.get(timeoutMs)?.abortController !== abortController) {
      return;
    }
    this.activeProbes.delete(timeoutMs);
  }
}
