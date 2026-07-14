import type { ProviderCommandError, ProviderError } from './domain/errors.ts';
import type { RuntimeFailureKind, RuntimeFailurePhase } from './application/constants/runtime.ts';
import type {
  EmitOutboundMessageInput,
  EmitOutboundRunInput,
  MessageDoneFact,
  MessageStartFact,
  OutboundFact,
  PermissionAskFact,
  PermissionReplyFact,
  ProviderAbortSessionInput,
  ProviderCloseSessionInput,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderFact,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderSlashCommand,
  ProviderTerminalResult,
  QuestionAnswer,
  QuestionAskFact,
  QuestionItem,
  QuestionOption,
  RuntimeOutboundEmitter,
  SessionTitleFact,
  SessionErrorFact,
  TextDeltaFact,
  TextDoneFact,
  ThinkingDeltaFact,
  ThinkingDoneFact,
  ThirdPartyAgentProvider,
  ToolUpdateFact,
} from './domain/provider.ts';

export type {
  EmitOutboundMessageInput,
  EmitOutboundRunInput,
  MessageDoneFact,
  MessageStartFact,
  OutboundFact,
  PermissionAskFact,
  PermissionReplyFact,
  ProviderAbortSessionInput,
  ProviderCloseSessionInput,
  ProviderCommandError,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderError,
  ProviderFact,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
  ProviderSlashCommand,
  ProviderTerminalResult,
  QuestionAnswer,
  QuestionAskFact,
  QuestionItem,
  QuestionOption,
  RuntimeOutboundEmitter,
  SessionTitleFact,
  SessionErrorFact,
  TextDeltaFact,
  TextDoneFact,
  ThinkingDeltaFact,
  ThinkingDoneFact,
  ThirdPartyAgentProvider,
  ToolUpdateFact,
};

export type ActiveRunChatPolicy = 'reject' | 'forwardToProvider';

export interface RequestRunPolicyOptions {
  activeRunChatPolicy?: ActiveRunChatPolicy;
}

export { qrcodeAuth } from '@wecode/skill-qrcode-auth';
export type {
  QrCodeAssistantInfo,
  QrCodeAuth,
  QrCodeAuthEnvironment,
  QrCodeAuthFailureReasonCode,
  QrCodeAuthPolicy,
  QrCodeAuthRunInput,
  QrCodeAuthServiceError,
  QrCodeAuthSnapshot,
  QrCodeDisplayData,
} from '@wecode/skill-qrcode-auth';

/**
 * `channel` 是接入方定义的业务渠道标识，SDK 不对具体字面量做产品级限制。
 */
export type BridgeGatewayChannel = string;

/**
 * Bridge runtime 使用的最小日志端口。
 */
export interface BridgeGatewayLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
  child?: (meta: Record<string, unknown>) => BridgeGatewayLogger;
  getTraceId?: () => string;
}

/**
 * Gateway host bootstrap 所需的最小稳定输入。
 */
export interface BridgeGatewayHostConfig {
  url?: string;
  auth: {
    ak: string;
    sk: string;
  };
  register: {
    channel: BridgeGatewayChannel;
    toolVersion: string;
    pluginVersion?: string;
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

/**
 * Provider 调用的公开诊断 trace；标识字段由 command 决定。
 */
export type RuntimeTraceProviderCall =
  | {
      command: 'startRequestRun';
      toolSessionId: string;
      runId: string;
      runIds?: never;
    }
  | {
      command: 'abortExecution';
      toolSessionId: string;
      runId?: never;
      runIds: string[];
    }
  | {
      command: 'closeSession';
      toolSessionId: string;
      runId?: never;
      runIds?: never;
    }
  | {
      command:
        | 'queryStatus'
        | 'createSession'
        | 'listSlashCommands'
        | 'replyQuestion'
        | 'replyPermission';
      toolSessionId?: never;
      runId?: never;
      runIds?: never;
    };

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
  action: 'register' | 'consume';
  kind?: 'question' | 'permission';
  toolSessionId: string;
  tokenId?: string;
}

/**
 * 并发 request run 策略的公开诊断 trace。
 */
export interface RuntimeTraceRequestRunPolicy {
  action: 'concurrent_request_runs_detected';
  toolSessionId: string;
  newRunId: string;
  activeRunCount: number;
  policy: 'forwardToProvider';
}

export interface RuntimeTraceFailure {
  kind: RuntimeFailureKind;
  phase: RuntimeFailurePhase;
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
  requestRunPolicies: RuntimeTraceRequestRunPolicy[];
  derivedEvents: Array<{ type: string; toolSessionId: string }>;
  failures: RuntimeTraceFailure[];
}

export type BridgeRuntimeErrorCode =
  | 'gateway_connect_parameter_invalid'
  | 'gateway_auth_rejected'
  | 'gateway_handshake_timeout'
  | 'gateway_handshake_rejected'
  | 'gateway_handshake_invalid'
  | 'gateway_transport_error'
  | 'gateway_reconnect_exhausted'
  | 'gateway_unknown_error'
  | 'provider_unavailable'
  | 'runtime_internal_error'
  | 'runtime_unknown_error'
  | 'probe_unknown_error';

/**
 * Bridge runtime public API 抛出的稳定错误结构。
 */
export class BridgeRuntimeError extends Error {
  override readonly name = 'BridgeRuntimeError';
  readonly code: BridgeRuntimeErrorCode;

  constructor(code: BridgeRuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
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
  error?: BridgeRuntimeError;
}

export interface BridgeRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  probe(input?: { timeoutMs: number }): Promise<BridgeGatewayProbeResult>;
  getStatus(): BridgeRuntimeStatusSnapshot;
  getDiagnostics(): RuntimeDiagnostics;
}

export interface BridgeRuntimeOptions {
  provider: ThirdPartyAgentProvider;
  gatewayHost: BridgeGatewayHostConfig;
  requestRunPolicy?: RequestRunPolicyOptions;
  logger?: BridgeGatewayLogger;
  debug?: boolean;
  traceIdFactory?: () => string;
  onTelemetryUpdated?: () => void;
}

export declare function resolvePackageVersion(): string | undefined;
export declare function createBridgeRuntime(options: BridgeRuntimeOptions): Promise<BridgeRuntime>;
