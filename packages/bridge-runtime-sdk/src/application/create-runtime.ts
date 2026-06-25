import { randomUUID } from 'node:crypto';

import { BridgeGatewayLoggerObservationAdapter } from '../adapters/observation/runtime-logger-observation.ts';
import { RuntimeTraceCollectorAdapter } from '../adapters/observation/runtime-trace-observation.ts';
import type { ThirdPartyAgentProvider } from '../domain/provider.ts';
import {
  CompositeRuntimeObservationPort,
  DefaultRuntimeObservation,
} from './runtime-observation/index.ts';
import type { BridgeRuntime } from './runtime.ts';
import type {
  BridgeGatewayHostConfig,
  BridgeGatewayLogger,
  BridgeGatewayProbeResult,
} from '../infrastructure/gateway/gateway-host.ts';
import { DEFAULT_PROBE_TIMEOUT_MS } from './constants/runtime.ts';
import { RuntimeLifecycleService } from './lifecycle/RuntimeLifecycleService.ts';
import { RuntimeProbeService } from './lifecycle/RuntimeProbeService.ts';
import { createApplicationRuntimeSide } from './runtime-assembly/createApplicationRuntimeSide.ts';
import { createGatewayRuntimeSide } from './runtime-assembly/createGatewayRuntimeSide.ts';
import { attachRuntimeDriverHandlers } from './runtime-assembly/downstream.ts';
import type { BridgeRuntimeInternalOptions } from './runtime-assembly/runtime-options.types.ts';

/**
 * 创建 host runtime 所需的公开配置。
 */
export interface BridgeRuntimeOptions {
  provider: ThirdPartyAgentProvider;
  gatewayHost: BridgeGatewayHostConfig;
  logger?: BridgeGatewayLogger;
  debug?: boolean;
  traceIdFactory?: () => string;
  onTelemetryUpdated?: () => void;
}

/**
 * 创建默认 bridge runtime。
 * @remarks
 * 该入口只负责 host runtime bootstrap 与 composition root。
 */
export async function createBridgeRuntime(options: BridgeRuntimeOptions): Promise<BridgeRuntime> {
  const internalOptions = options as BridgeRuntimeInternalOptions;
  const traceAdapter = new RuntimeTraceCollectorAdapter();
  const observationPort = new CompositeRuntimeObservationPort([
    traceAdapter,
    new BridgeGatewayLoggerObservationAdapter(options.logger),
  ]);
  const observation = new DefaultRuntimeObservation(observationPort);
  const gatewaySide = createGatewayRuntimeSide(options, internalOptions, observation);
  const applicationSide = createApplicationRuntimeSide(options, internalOptions, observation, gatewaySide.sink);
  const probe = new RuntimeProbeService(gatewaySide.probeDriver);
  const lifecycle = new RuntimeLifecycleService(
    applicationSide.core,
    gatewaySide.runtimeDriver,
    observation,
    options.onTelemetryUpdated,
  );

  attachRuntimeDriverHandlers({
    driver: gatewaySide.runtimeDriver,
    core: applicationSide.core,
    lifecycle,
    observation,
    traceIdFactory: options.traceIdFactory ?? randomUUID,
    commandFailureToolErrorProjector: applicationSide.commandFailureToolErrorProjector,
    sink: gatewaySide.sink,
  });

  return {
    async start(): Promise<void> {
      await probe.cancelActiveProbe();
      return lifecycle.start();
    },
    async stop(): Promise<void> {
      await probe.cancelActiveProbe();
      return lifecycle.stop();
    },
    getStatus() {
      return lifecycle.getStatus();
    },
    async probe(input = { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS }): Promise<BridgeGatewayProbeResult> {
      return probe.probe(lifecycle.getStatus(), input);
    },
    getDiagnostics() {
      return traceAdapter.snapshot();
    },
  };
}
