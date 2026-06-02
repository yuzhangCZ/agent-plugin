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
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
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
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ProviderRuntimeContext,
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

/**
 * 二维码展示层消费的数据，不包含渲染策略。
 */
export interface QrCodeDisplayData {
  qrcode: string;
  weUrl: string;
  pcUrl: string;
}

/**
 * 授权服务错误的安全子集，不透传敏感上下文。
 */
export interface QrCodeAuthServiceError {
  code?: string;
  httpStatus?: number;
  businessCode?: string;
  error?: string;
  message?: string;
  errorEn?: string;
}

export type QrCodeAuthFailureReasonCode = 'timeout' | 'network_error' | 'auth_service_error';

/**
 * 二维码授权固定环境枚举。
 */
export type QrCodeAuthEnvironment = 'uat' | 'prod';

/**
 * 调用方可感知的二维码授权事件。
 */
export type QrCodeAuthSnapshot =
  | {
      type: 'qrcode_generated';
      qrcode: string;
      display: QrCodeDisplayData;
      expiresAt: string;
    }
  | {
      type: 'scanned';
      qrcode: string;
    }
  | {
      type: 'expired';
      qrcode: string;
    }
  | {
      type: 'cancelled';
      qrcode: string;
    }
  | {
      type: 'confirmed';
      qrcode: string;
      credentials: {
        ak: string;
        sk: string;
      };
    }
  | {
      type: 'failed';
      qrcode?: string;
      reasonCode: QrCodeAuthFailureReasonCode;
      serviceError?: QrCodeAuthServiceError;
    };

/**
 * 控制自动刷新与轮询节奏的策略。
 */
export interface QrCodeAuthPolicy {
  refreshOnExpired?: boolean;
  maxRefreshCount?: number;
  pollIntervalMs?: number;
}

/**
 * `run()` 的完整输入。
 */
export interface QrCodeAuthRunInput {
  /**
   * 授权环境；未传时默认 `prod`。
   */
  environment?: QrCodeAuthEnvironment;
  channel: string;
  mac: string;
  policy?: QrCodeAuthPolicy;
  onSnapshot: (snapshot: QrCodeAuthSnapshot) => void;
}

/**
 * 对外暴露的唯一高层授权入口。
 */
export interface QrCodeAuth {
  run(input: QrCodeAuthRunInput): Promise<void>;
}

/**
 * `toolType` 由接入方定义，SDK 不对具体字面量做产品级限制。
 */
export type BridgeGatewayToolType = string;

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
    toolType: BridgeGatewayToolType;
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
  action: 'register' | 'consume';
  kind?: 'question' | 'permission';
  toolSessionId: string;
  tokenId?: string;
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
  derivedEvents: Array<{ type: string; toolSessionId: string }>;
  failures: RuntimeTraceFailure[];
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
  logger?: BridgeGatewayLogger;
  debug?: boolean;
  traceIdFactory?: () => string;
  onTelemetryUpdated?: () => void;
}

export declare const qrcodeAuth: QrCodeAuth;
export declare function resolvePackageVersion(): string | undefined;
export declare function createBridgeRuntime(options: BridgeRuntimeOptions): Promise<BridgeRuntime>;
