export type RuntimeFailureKind =
  | 'startup_failure'
  | 'gateway_runtime_failure'
  | 'command_execution_failure'
  | 'inbound_validation_failure'
  | 'outbound_validation_failure';

export type RuntimeFailurePhase = 'start' | 'runtime' | 'stop';
