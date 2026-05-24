export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_PROVIDER_RUN_FAILURE_MESSAGE = 'provider_run_failed';

export const RUNTIME_FAILURE_KIND = {
  startup: 'startup_failure',
  gatewayRuntime: 'gateway_runtime_failure',
  commandExecution: 'command_execution_failure',
  inboundValidation: 'inbound_validation_failure',
  outboundValidation: 'outbound_validation_failure',
} as const;

export const RUNTIME_FAILURE_PHASE = {
  start: 'start',
  runtime: 'runtime',
  stop: 'stop',
} as const;

export type RuntimeFailureKind = (typeof RUNTIME_FAILURE_KIND)[keyof typeof RUNTIME_FAILURE_KIND];
export type RuntimeFailurePhase = (typeof RUNTIME_FAILURE_PHASE)[keyof typeof RUNTIME_FAILURE_PHASE];
