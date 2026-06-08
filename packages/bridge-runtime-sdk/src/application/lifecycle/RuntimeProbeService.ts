import type { BridgeGatewayProbeResult } from '../../infrastructure/gateway/gateway-host.ts';
import { DEFAULT_PROBE_TIMEOUT_MS } from '../constants/runtime.ts';
import type { GatewayProbeDriver } from '../ports/gateway-runtime-driver.ts';
import type { BridgeRuntimeStatusSnapshot } from '../runtime.ts';
import { createBridgeRuntimeError } from '../runtime-error.ts';

/**
 * runtime gateway 探测服务。
 * @remarks probe 使用临时连接，是 lifecycle 的旁路能力，不驱动主状态机。
 */
export class RuntimeProbeService {
  private readonly driver: GatewayProbeDriver;
  private probePromise: Promise<BridgeGatewayProbeResult> | null = null;
  private probeAbortController: AbortController | null = null;

  constructor(driver: GatewayProbeDriver) {
    this.driver = driver;
  }

  /**
   * 取消当前临时 probe。
   * @remarks 这是 start/stop 前的旁路清理，失败不向 lifecycle 传播。
   */
  async cancelActiveProbe(): Promise<void> {
    if (!this.probePromise || !this.probeAbortController) {
      return;
    }
    try {
      this.probeAbortController.abort(new Error('probe_cancelled_for_runtime_lifecycle'));
      await this.probePromise.catch(() => undefined);
    } catch {
      // cancel 是 best-effort；probe service 内部闭环，不污染 start/stop 语义。
    }
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

    if (this.probePromise) {
      return this.probePromise;
    }

    const abortController = new AbortController();
    this.probeAbortController = abortController;
    try {
      const pendingProbe = this.driver.probe({
        timeoutMs: input.timeoutMs,
        abortSignal: abortController.signal,
      });
      this.probePromise = pendingProbe.catch((error) => {
        throw createBridgeRuntimeError('runtime_probe_failed', error);
      }).finally(() => {
        this.clearActiveProbe(abortController);
      });
    } catch (error) {
      this.clearActiveProbe(abortController);
      throw createBridgeRuntimeError('runtime_probe_failed', error);
    }
    return this.probePromise;
  }

  private clearActiveProbe(abortController: AbortController): void {
    if (this.probeAbortController !== abortController) {
      return;
    }
    this.probePromise = null;
    this.probeAbortController = null;
  }
}
