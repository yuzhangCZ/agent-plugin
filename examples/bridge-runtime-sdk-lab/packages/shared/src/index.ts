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

export type ProviderScenarioKind = 'success' | 'offline' | 'throw' | 'timeout' | 'invalid_fact' | 'failed_run' | 'aborted_run';

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
  events: LabEvent[];
}

export type DownstreamExpectedOutcome =
  | 'tool_error'
  | 'failure_only'
  | 'session_created'
  | 'tool_done'
  | 'status_response'
  | 'slash_commands_result';

export interface DownstreamScenario {
  id: string;
  group: string;
  title: string;
  description: string;
  raw: unknown;
  expected: {
    outcome: DownstreamExpectedOutcome;
    stage: 'inbound_validation' | 'command_execution' | 'interaction_resolution' | 'provider_call' | 'success';
    errorIncludes?: string;
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
