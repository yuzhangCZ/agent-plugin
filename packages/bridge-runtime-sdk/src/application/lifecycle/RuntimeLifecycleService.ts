import type {
  BridgeGatewayHostError,
  BridgeGatewayHostState,
} from '../../infrastructure/gateway/gateway-host.ts';
import { RUNTIME_FAILURE_KIND } from '../constants/runtime.ts';
import type { GatewayRuntimeDriver } from '../ports/gateway-runtime-driver.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';
import type { BridgeRuntimeStatusSnapshot } from '../runtime.ts';
import { createBridgeRuntimeError, normalizeErrorMessage } from '../runtime-error.ts';
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
    const runtimeError = createBridgeRuntimeError('runtime_gateway_error', error);
    this.setFailed(RUNTIME_FAILURE_KIND.gatewayRuntime, 'runtime', runtimeError, error.code);
    this.onTelemetryUpdated?.();
  }

  async start(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
    }
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
        await this.core.start();
        await this.driver.connect();
        this.status = {
          state: 'ready',
          failureReason: null,
        };
        this.observation.runtimeStartCompleted();
        this.onTelemetryUpdated?.();
      } catch (error) {
        const runtimeError = createBridgeRuntimeError('runtime_start_failed', error);
        const cleanupError = this.disconnectBestEffort();
        if (cleanupError) {
          this.recordFailure(RUNTIME_FAILURE_KIND.gatewayRuntime, 'start', cleanupError);
        }
        this.setFailed(RUNTIME_FAILURE_KIND.startup, 'start', runtimeError, runtimeError.code);
        this.observation.runtimeStartFailed(runtimeError, runtimeError.code);
        this.onTelemetryUpdated?.();
        throw runtimeError;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
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
        let primaryError: unknown | null = null;
        if (this.startPromise) {
          primaryError = this.disconnectBestEffort();
          await this.startPromise.catch(() => undefined);
        }
        primaryError = primaryError ?? this.disconnectBestEffort();
        try {
          await this.core.stop();
        } catch (error) {
          if (primaryError) {
            this.recordFailure(RUNTIME_FAILURE_KIND.gatewayRuntime, 'stop', primaryError);
          }
          primaryError = error;
        }
        if (primaryError) {
          throw primaryError;
        }
        this.status = {
          state: 'idle',
          failureReason: null,
        };
        this.observation.runtimeStopCompleted();
        this.onTelemetryUpdated?.();
      } catch (error) {
        const runtimeError = createBridgeRuntimeError('runtime_stop_failed', error);
        this.setFailed(RUNTIME_FAILURE_KIND.gatewayRuntime, 'stop', runtimeError, runtimeError.code);
        this.observation.runtimeStopFailed(runtimeError, runtimeError.code);
        this.onTelemetryUpdated?.();
        throw runtimeError;
      } finally {
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  getStatus(): BridgeRuntimeStatusSnapshot {
    return { ...this.status };
  }

  recordFailure(kind: RuntimeFailureKind, phase: RuntimeFailurePhase, error: unknown, code?: string): string {
    const message = normalizeErrorMessage(error);
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

  private disconnectBestEffort(): unknown | null {
    try {
      this.driver.disconnect();
      return null;
    } catch (error) {
      return error;
    }
  }

  private isGatewayReady(state: BridgeGatewayHostState): boolean {
    return state === 'READY';
  }

  private isGatewayRecovering(state: BridgeGatewayHostState): boolean {
    return state === 'CONNECTING' || state === 'CONNECTED' || state === 'DISCONNECTED';
  }
}
