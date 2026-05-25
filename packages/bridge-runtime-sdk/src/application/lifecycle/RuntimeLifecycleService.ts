import type {
  BridgeGatewayHostError,
  BridgeGatewayHostState,
  BridgeGatewayProbeResult,
} from '../../infrastructure/gateway/gateway-host.ts';
import { DEFAULT_PROBE_TIMEOUT_MS, RUNTIME_FAILURE_KIND } from '../constants/runtime.ts';
import type { GatewayRuntimeDriver } from '../ports/gateway-runtime-driver.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';
import type { BridgeRuntimeStatusSnapshot } from '../runtime.ts';
import type { RuntimeCore } from '../runtime/runtime-core.types.ts';
import type { RuntimeFailureKind, RuntimeFailurePhase } from './runtime-lifecycle.types.ts';

/**
 * host runtime 生命周期服务。
 */
export class RuntimeLifecycleService {
  private readonly core: RuntimeCore;
  private readonly driver: GatewayRuntimeDriver;
  private readonly observation: RuntimeObservation;
  private readonly onTelemetryUpdated?: () => void;
  private status: BridgeRuntimeStatusSnapshot = {
    state: 'idle',
    failureReason: null,
  };
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private probePromise: Promise<BridgeGatewayProbeResult> | null = null;
  private probeAbortController: AbortController | null = null;

  constructor(
    core: RuntimeCore,
    driver: GatewayRuntimeDriver,
    observation: RuntimeObservation,
    onTelemetryUpdated?: () => void,
  ) {
    this.core = core;
    this.driver = driver;
    this.observation = observation;
    this.onTelemetryUpdated = onTelemetryUpdated;
  }

  handleGatewayStateChanged(gatewayState: BridgeGatewayHostState): void {
    if (this.status.state === 'idle' || this.status.state === 'stopping' || this.status.state === 'failed') {
      return;
    }
    if (this.isGatewayReady(gatewayState)) {
      this.status = {
        state: 'ready',
        failureReason: null,
      };
      this.onTelemetryUpdated?.();
      return;
    }
    if (this.status.state !== 'starting' && this.isGatewayRecovering(gatewayState)) {
      this.status = {
        state: 'reconnecting',
        failureReason: null,
      };
      this.onTelemetryUpdated?.();
    }
  }

  handleGatewayRuntimeError(error: BridgeGatewayHostError): void {
    this.setFailed(RUNTIME_FAILURE_KIND.gatewayRuntime, 'runtime', error, error.code);
    this.onTelemetryUpdated?.();
  }

  async start(): Promise<void> {
    if (this.status.state === 'ready') {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.observation.runtimeStartRequested();
    this.status = {
      state: 'starting',
      failureReason: null,
    };
    this.onTelemetryUpdated?.();

    this.startPromise = (async () => {
      try {
        await this.cancelProbeForStart();
        await this.core.start();
        await this.driver.connect();
        this.status = {
          state: 'ready',
          failureReason: null,
        };
        this.observation.runtimeStartCompleted();
        this.onTelemetryUpdated?.();
      } catch (error) {
        this.driver.disconnect();
        this.setFailed(RUNTIME_FAILURE_KIND.startup, 'start', error);
        this.observation.runtimeStartFailed(error);
        this.onTelemetryUpdated?.();
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.probePromise) {
      await this.cancelProbeForStart();
    }
    if (this.status.state === 'idle') {
      return;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.observation.runtimeStopRequested();
    this.status = {
      state: 'stopping',
      failureReason: null,
    };
    this.onTelemetryUpdated?.();

    this.stopPromise = (async () => {
      try {
        await this.cancelProbeForStart();
        if (this.startPromise) {
          this.driver.disconnect();
          await this.startPromise.catch(() => undefined);
        }
        this.driver.disconnect();
        await this.core.stop();
        this.status = {
          state: 'idle',
          failureReason: null,
        };
        this.observation.runtimeStopCompleted();
        this.onTelemetryUpdated?.();
      } catch (error) {
        this.setFailed(RUNTIME_FAILURE_KIND.gatewayRuntime, 'stop', error);
        this.observation.runtimeStopFailed(error);
        this.onTelemetryUpdated?.();
        throw error;
      } finally {
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  getStatus(): BridgeRuntimeStatusSnapshot {
    return { ...this.status };
  }

  async probe(input = { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS }): Promise<BridgeGatewayProbeResult> {
    const startedAt = Date.now();
    if (this.status.state === 'ready') {
      return {
        state: 'ready',
        latencyMs: 0,
        reason: 'runtime_ready',
      };
    }

    if (this.status.state === 'starting' || this.status.state === 'reconnecting') {
      const waitMs = Math.min(input.timeoutMs, 1_000);
      if (this.startPromise) {
        await Promise.race([this.startPromise.catch(() => undefined), this.sleep(waitMs)]);
      } else {
        await this.sleep(waitMs);
      }
      const postWaitState = this.status.state;
      if (this.isRuntimeReady(postWaitState)) {
        return {
          state: 'ready',
          latencyMs: Math.max(0, Date.now() - startedAt),
          reason: 'runtime_connected_after_wait',
        };
      }
      return {
        state: 'connecting',
        latencyMs: Math.max(0, Date.now() - startedAt),
        reason: 'runtime_connecting_probe_skipped',
      };
    }

    if (this.probePromise) {
      return this.probePromise;
    }

    this.probeAbortController = new AbortController();
    this.probePromise = this.driver.probe({
      timeoutMs: input.timeoutMs,
      abortSignal: this.probeAbortController.signal,
    }).finally(() => {
      this.probePromise = null;
      this.probeAbortController = null;
    });
    return this.probePromise;
  }

  recordFailure(kind: RuntimeFailureKind, phase: RuntimeFailurePhase, error: unknown, code?: string): string {
    const message = this.normalizeErrorMessage(error);
    this.observation.failureRecorded(kind, phase, message, code);
    return message;
  }

  private setFailed(kind: RuntimeFailureKind, phase: RuntimeFailurePhase, error: unknown, code?: string): void {
    const message = this.recordFailure(kind, phase, error, code);
    this.status = {
      ...this.status,
      state: 'failed',
      failureReason: message,
    };
  }

  private async cancelProbeForStart(): Promise<void> {
    if (!this.probePromise || !this.probeAbortController) {
      return;
    }
    this.probeAbortController.abort(new Error('probe_cancelled_for_runtime_start'));
    await this.probePromise.catch(() => undefined);
  }

  private normalizeErrorMessage(error: unknown): string {
    if (
      typeof error === 'object'
      && error !== null
      && 'message' in error
      && typeof (error as { message?: unknown }).message === 'string'
    ) {
      return (error as { message: string }).message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private isGatewayReady(state: BridgeGatewayHostState): boolean {
    return state === 'READY';
  }

  private isGatewayRecovering(state: BridgeGatewayHostState): boolean {
    return state === 'CONNECTING' || state === 'CONNECTED' || state === 'DISCONNECTED';
  }

  private isRuntimeReady(state: BridgeRuntimeStatusSnapshot['state']): state is 'ready' {
    return state === 'ready';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
