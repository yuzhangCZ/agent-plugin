import type { GatewayClientStatus } from '@agent-plugin/gateway-client';
import { RUNTIME_FAILURE_KIND } from '../constants/runtime.ts';
import type { GatewayRuntimeDriver } from '../ports/gateway-runtime-driver.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';
import type { BridgeRuntimeStatusSnapshot } from '../runtime.ts';
import {
  BridgeRuntimeError,
  normalizeErrorMessage,
} from '../runtime-error.ts';
import {
  fromGatewayClosedFailure,
  fromGatewayConnectFailure,
  fromProviderStartFailure,
  fromRuntimeInternalFailure,
} from '../runtime-error-classifier.ts';
import type { RuntimeCore } from '../runtime/runtime-core.types.ts';
import { RuntimeLifecycleState } from './RuntimeLifecycleState.ts';
import type { RuntimeFailureKind, RuntimeFailurePhase } from './runtime-lifecycle.types.ts';

/**
 * host runtime 生命周期服务。
 */
export class RuntimeLifecycleService {
  private readonly core: RuntimeCore;
  private readonly driver: GatewayRuntimeDriver;
  private readonly observation: RuntimeObservation;
  private readonly onTelemetryUpdated?: () => void;
  private readonly state = new RuntimeLifecycleState();
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

  handleGatewayStatusChanged(status: GatewayClientStatus): void {
    if (this.state.shouldIgnoreGatewayStatus()) {
      return;
    }

    if (status.isReady()) {
      this.markReadyFromGateway();
      return;
    }
    if (status.isReconnecting()) {
      this.markReconnectingFromGateway();
      return;
    }
    if (status.isFailureClosed()) {
      this.markFailedFromGatewayClosed(status);
    }
  }

  async start(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.state.isReady()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.observation.runtimeStartRequested();
    const startAttemptId = this.state.beginStart();
    this.onTelemetryUpdated?.();

    this.startPromise = this.runStartAttempt(startAttemptId)
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.state.isIdle()) {
      return;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.observation.runtimeStopRequested();
    const stopAttemptId = this.state.beginStop();
    this.onTelemetryUpdated?.();

    this.stopPromise = (async () => {
      try {
        let primaryError: unknown | null = null;
        const inFlightStart = this.startPromise;
        if (inFlightStart) {
          primaryError = await this.disconnectBestEffort();
          await inFlightStart.catch(() => undefined);
        }
        primaryError = primaryError ?? (await this.disconnectBestEffort());
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
        if (this.state.finishStopIfCurrent(stopAttemptId)) {
          this.observation.runtimeStopCompleted();
          this.onTelemetryUpdated?.();
        }
      } catch (error) {
        const runtimeError = fromRuntimeInternalFailure(error);
        this.setFailed(RUNTIME_FAILURE_KIND.gatewayRuntime, 'stop', runtimeError);
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
    return this.state.snapshot();
  }

  private async runStartAttempt(startAttemptId: number): Promise<void> {
    await this.startCoreOrFail(startAttemptId);
    await this.connectGatewayOrFail(startAttemptId);

    if (this.state.finishStartIfCurrent(startAttemptId)) {
      this.observation.runtimeStartCompleted();
      this.onTelemetryUpdated?.();
    }
  }

  private async startCoreOrFail(startAttemptId: number): Promise<void> {
    try {
      await this.core.start();
    } catch (error) {
      const runtimeError = fromProviderStartFailure(error);
      if (this.state.failStartIfCurrent(startAttemptId, runtimeError)) {
        this.publishStartFailure(runtimeError);
      }
      throw runtimeError;
    }
  }

  private async connectGatewayOrFail(startAttemptId: number): Promise<void> {
    try {
      await this.driver.connect();
    } catch (error) {
      const runtimeError = fromGatewayConnectFailure(error);
      const cleanupError = await this.disconnectBestEffort();
      if (!this.state.failStartIfCurrent(startAttemptId, runtimeError)) {
        return;
      }
      if (cleanupError) {
        const cleanupRuntimeError = fromRuntimeInternalFailure(cleanupError);
        this.recordFailure(
          RUNTIME_FAILURE_KIND.gatewayRuntime,
          'start',
          cleanupRuntimeError,
          cleanupRuntimeError.code,
        );
      }
      this.publishStartFailure(runtimeError);
      throw runtimeError;
    }
  }

  private publishStartFailure(runtimeError: BridgeRuntimeError): void {
    this.recordFailure(RUNTIME_FAILURE_KIND.startup, 'start', runtimeError, runtimeError.code);
    this.observation.runtimeStartFailed(runtimeError, runtimeError.code);
    this.onTelemetryUpdated?.();
  }

  recordFailure(kind: RuntimeFailureKind, phase: RuntimeFailurePhase, error: unknown, code?: string): string {
    const message = normalizeErrorMessage(error);
    this.observation.failureRecorded(kind, phase, message, code);
    return message;
  }

  private setFailed(
    kind: RuntimeFailureKind,
    phase: RuntimeFailurePhase,
    runtimeError: BridgeRuntimeError,
    diagnosticCode: string = runtimeError.code,
  ): void {
    this.recordFailure(kind, phase, runtimeError, diagnosticCode);
    this.state.markFailed(runtimeError);
  }

  private markReadyFromGateway(): void {
    if (this.state.isStarting()) {
      return;
    }
    this.state.markReady();
    this.onTelemetryUpdated?.();
  }

  private markReconnectingFromGateway(): void {
    if (this.state.isStarting()) {
      return;
    }
    this.state.markReconnecting();
    this.onTelemetryUpdated?.();
  }

  private markFailedFromGatewayClosed(status: GatewayClientStatus): void {
    const error = status.getError();
    const runtimeError = fromGatewayClosedFailure(error);
    if (!runtimeError) {
      return;
    }
    const diagnosticCode = error?.code ?? runtimeError.code;
    this.setFailed(
      RUNTIME_FAILURE_KIND.gatewayRuntime,
      'runtime',
      runtimeError,
      diagnosticCode,
    );
    this.onTelemetryUpdated?.();
  }

  private async disconnectBestEffort(): Promise<unknown | null> {
    try {
      await this.driver.disconnect();
      return null;
    } catch (error) {
      return error;
    }
  }

}
