export type GatewayMode = 'real-gateway' | 'mock-gateway';

export interface SafeGatewayConfig {
  url?: string;
  authLoaded: boolean;
  register: {
    channel: string;
    toolVersion: string;
    pluginVersion?: string;
  };
}

export interface RuntimeActionResult<TPayload = unknown> {
  ok: boolean;
  action: string;
  payload?: TPayload;
  error?: {
    name: string;
    message: string;
    code?: string;
  };
}

export type ProviderScenarioKind =
  | 'success'
  | 'offline'
  | 'throw'
  | 'timeout'
  | 'invalid_fact'
  | 'failed_run'
  | 'session_not_found'
  | 'result_reject'
  | 'facts_throw'
  | 'enrich_failure'
  | 'aborted_run';

export interface ProviderScenarioConfig {
  command: string;
  kind: ProviderScenarioKind;
  delayMs?: number;
}

export interface LabEvent {
  id: number;
  at: number;
  type: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface RuntimeSnapshot {
  mode: GatewayMode;
  gateway?: SafeGatewayConfig;
  status?: unknown;
  diagnostics?: unknown;
  downstreams?: LabGatewayDownstreamView[];
  events: LabEvent[];
}

export interface LabGatewayDownstreamView {
  id: number;
  at: number;
  source: GatewayMode | 'sdk-observation';
  phase: 'received' | 'handled' | 'failed' | 'invalid_invoke_rejected' | 'mock_sent';
  messageType?: string;
  action?: string;
  command?: string;
  toolSessionId?: string;
  welinkSessionId?: string;
  traceId?: string;
  error?: string;
  code?: string;
  raw?: unknown;
}

export type DownstreamExpectedOutcome =
  | 'tool_error'
  | 'failure_only'
  | 'diagnostics_only'
  | 'session_created'
  | 'tool_done'
  | 'runtime_failed'
  | 'status_response'
  | 'slash_commands_result';

export type LabScenarioTrigger = 'gateway_downstream' | 'provider_outbound' | 'mock_gateway_disconnect';

export type ToolErrorStage =
  | 'inbound_invalid'
  | 'command_failure'
  | 'request_lifecycle'
  | 'request_terminal'
  | 'outbound_terminal'
  | 'diagnostics_only'
  | 'lifecycle_status'
  | 'success';

export interface DownstreamScenario {
  id: string;
  group: string;
  title: string;
  description: string;
  trigger?: LabScenarioTrigger;
  raw: unknown;
  expected: {
    outcome: DownstreamExpectedOutcome;
    stage: ToolErrorStage;
    errorIncludes?: string;
    reason?: string;
    providerScenario?: ProviderScenarioConfig;
  };
}

export interface ToolErrorView {
  error: string;
  toolSessionId?: string;
  welinkSessionId?: string;
  reason?: string;
  stage: DownstreamScenario['expected']['stage'];
}

export interface DownstreamRunResult {
  scenario: DownstreamScenario;
  raw: unknown;
  uplinks: unknown[];
  toolErrors: ToolErrorView[];
  failures: unknown[];
  matchedExpectation: boolean;
  note?: string;
}
