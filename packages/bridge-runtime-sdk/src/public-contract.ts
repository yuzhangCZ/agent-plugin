import type {
  EmitOutboundMessageInput,
  OutboundFact,
  PermissionAskFact,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderFact,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderTerminalResult,
  RuntimeOutboundEmitter,
  SessionErrorFact,
  ThirdPartyAgentProvider,
  ToolUpdateFact,
} from './domain/provider.ts';
import type { ProviderCommandError, ProviderError } from './domain/errors.ts';

export type {
  EmitOutboundMessageInput,
  OutboundFact,
  PermissionAskFact,
  ProviderCommandError,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderError,
  ProviderFact,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderTerminalResult,
  RuntimeOutboundEmitter,
  SessionErrorFact,
  ThirdPartyAgentProvider,
  ToolUpdateFact,
};

export type BridgeGatewayToolType = 'openx' | 'openclaw' | 'opencode';

export interface BridgeGatewayLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
  child?: (meta: Record<string, unknown>) => BridgeGatewayLogger;
  getTraceId?: () => string;
}

export interface BridgeGatewayHostConfig {
  url?: string;
  auth: {
    ak: string;
    sk: string;
  };
  register: {
    toolType: BridgeGatewayToolType;
    toolVersion: string;
  };
}

export type BridgeGatewayProbeState =
  | 'ready'
  | 'rejected'
  | 'connect_error'
  | 'timeout'
  | 'connecting'
  | 'cancelled';

export interface BridgeGatewayProbeResult {
  state: BridgeGatewayProbeState;
  latencyMs: number;
  reason?: string;
}

export type BridgeRuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'failed';

export interface BridgeRuntimeStatusSnapshot {
  state: BridgeRuntimeStatus;
  failureReason: string | null;
}

export interface RuntimeTraceProviderCall {
  command:
    | 'queryStatus'
    | 'createSession'
    | 'startRequestRun'
    | 'replyQuestion'
    | 'replyPermission'
    | 'closeSession'
    | 'abortExecution';
  toolSessionId?: string;
  runId?: string;
}

export interface RuntimeTraceFact {
  type: ProviderFact['type'];
  toolSessionId: string;
  messageId?: string;
}

export interface RuntimeTraceTerminal {
  toolSessionId: string;
  outcome: ProviderTerminalResult['outcome'];
}

export interface RuntimeTraceInteraction {
  action: 'register' | 'consume' | 'clear';
  kind?: 'question' | 'permission';
  toolSessionId: string;
  tokenId?: string;
}

export interface RuntimeTraceFailure {
  kind:
    | 'startup_failure'
    | 'gateway_runtime_failure'
    | 'command_execution_failure'
    | 'inbound_validation_failure'
    | 'outbound_validation_failure';
  phase: 'start' | 'runtime' | 'stop';
  message: string;
  code?: string;
}

export interface RuntimeDiagnostics {
  gatewayState?: string;
  lastReadyAt: number | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastHeartbeatAt: number | null;
  providerCalls: RuntimeTraceProviderCall[];
  facts: RuntimeTraceFact[];
  uplinks: Array<{ type: string; toolSessionId?: string }>;
  terminals: RuntimeTraceTerminal[];
  interactions: RuntimeTraceInteraction[];
  derivedEvents: Array<{ type: string; toolSessionId: string }>;
  failures: RuntimeTraceFailure[];
}

export interface BridgeRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  probe(input?: { timeoutMs: number }): Promise<BridgeGatewayProbeResult>;
  getStatus(): BridgeRuntimeStatusSnapshot;
  getDiagnostics(): RuntimeDiagnostics;
}

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

export declare function resolvePackageVersion(): string;
export declare function createBridgeRuntime(options: BridgeRuntimeOptions): Promise<BridgeRuntime>;
