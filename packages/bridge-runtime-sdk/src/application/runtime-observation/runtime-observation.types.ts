import type { GatewayDownstreamBusinessRequest, GatewayUplinkBusinessMessage, SkillProviderEvent } from '@agent-plugin/gateway-schema';

import type { BridgeGatewayProbeResult } from '../../public-contract.ts';
import type { RuntimeFailureKind, RuntimeFailurePhase } from '../constants/runtime.ts';
import type { ProviderFact, ProviderTerminalResult } from '../../domain/provider.ts';
import type { LifecycleProfileKind } from '../fact-sequence-validator.ts';

/**
 * runtime command 名称闭集。
 */
export type RuntimeObservationCommand =
  | 'query_status'
  | 'create_session'
  | 'list_slash_commands'
  | 'start_request_run'
  | 'reply_question'
  | 'reply_permission'
  | 'close_session'
  | 'abort_execution';

/**
 * provider command 名称闭集。
 */
export type RuntimeObservationProviderCommand =
  | 'queryStatus'
  | 'createSession'
  | 'listSlashCommands'
  | 'startRequestRun'
  | 'replyQuestion'
  | 'replyPermission'
  | 'closeSession'
  | 'abortExecution';

/**
 * runtime lifecycle 观测事件。
 */
export type RuntimeLifecycleObservationEvent = {
  type: 'runtime_lifecycle';
  action:
    | 'start_requested'
    | 'start_completed'
    | 'start_failed'
    | 'stop_requested'
    | 'stop_completed'
    | 'stop_failed'
    | 'core_started'
    | 'core_stopped';
  failureReason?: string;
  code?: string;
};

/**
 * gateway 状态变化观测事件。
 */
export type GatewayStateChangedObservationEvent = {
  type: 'gateway_state_changed';
  state: string;
  occurredAt?: number;
};

/**
 * gateway 活动时间戳观测事件。
 */
export type GatewayActivityObservationEvent = {
  type: 'gateway_activity';
  activity: 'inbound' | 'outbound' | 'heartbeat';
  occurredAt?: number;
};

/**
 * gateway 临时 probe 观测事件。
 */
export type GatewayProbeObservationEvent =
  | {
      type: 'gateway_probe';
      phase: 'requested';
      gatewayUrl: string;
      timeoutMs: number;
    }
  | {
      type: 'gateway_probe';
      phase: 'completed';
      gatewayUrl: string;
      state: BridgeGatewayProbeResult['state'];
      latencyMs: number;
      reason?: string;
    };

/**
 * downstream 接收观测事件。
 */
export type DownstreamReceivedObservationEvent = {
  type: 'downstream_received';
  messageType: GatewayDownstreamBusinessRequest['type'];
  action?: string;
  toolSessionId?: string;
  welinkSessionId?: string;
};

/**
 * downstream 处理结果观测事件。
 */
export type DownstreamProcessedObservationEvent = {
  type: 'downstream_processed';
  action: 'handled' | 'failed' | 'invalid_invoke_rejected';
  messageType?: GatewayDownstreamBusinessRequest['type'] | 'invoke';
  command?: RuntimeObservationCommand;
  toolSessionId?: string;
  welinkSessionId?: string;
  error?: string;
  code?: string;
};

/**
 * runtime command 分发观测事件。
 */
export type CommandDispatchedObservationEvent = {
  type: 'command_dispatched';
  phase: 'dispatched' | 'completed' | 'failed';
  command: RuntimeObservationCommand;
  traceId: string;
  toolSessionId?: string;
  welinkSessionId?: string;
  error?: string;
  code?: string;
};

/**
 * use case 执行观测事件。
 */
export type UsecaseProgressObservationEvent = {
  type: 'usecase_progress';
  phase: 'started' | 'succeeded' | 'failed' | 'conflict';
  usecase: RuntimeObservationCommand;
  traceId: string;
  toolSessionId?: string;
  welinkSessionId?: string;
  runId?: string;
  outcome?: ProviderTerminalResult['outcome'];
  error?: string;
  code?: string;
};

/**
 * provider 调用边界观测事件。
 */
export type ProviderCallObservationEvent = {
  type: 'provider_call';
  phase: 'started' | 'succeeded' | 'failed';
  command: RuntimeObservationProviderCommand;
  traceId?: string;
  toolSessionId?: string;
  runId?: string;
  error?: string;
  code?: string;
};

/**
 * fact 处理观测事件。
 */
export type FactProcessedObservationEvent =
  | {
      type: 'fact_processed';
      phase: 'received';
      toolSessionId: string;
      fact: ProviderFact;
      profile: LifecycleProfileKind;
    }
  | {
      type: 'fact_processed';
      phase: 'derived_event_projected';
      toolSessionId: string;
      factType: ProviderFact['type'];
      event: SkillProviderEvent;
      profile: LifecycleProfileKind;
    }
  | {
      type: 'fact_processed';
      phase: 'projected';
      toolSessionId: string;
      factType: ProviderFact['type'];
      uplinkType: GatewayUplinkBusinessMessage['type'];
      profile: LifecycleProfileKind;
    };

/**
 * interaction 状态变化观测事件。
 */
export type InteractionChangedObservationEvent = {
  type: 'interaction_changed';
  action: 'register' | 'consume' | 'conflict';
  kind?: 'question' | 'permission';
  toolSessionId: string;
  tokenId?: string;
  conflictingToolSessionId?: string;
};

/**
 * uplink 生命周期观测事件。
 */
export type UplinkObservationEvent =
  | {
      type: 'uplink_emitted';
      message: GatewayUplinkBusinessMessage;
    }
  | {
      type: 'uplink_validation';
      phase: 'sending' | 'validated' | 'validation_failed';
      messageType: GatewayUplinkBusinessMessage['type'];
      eventType?: string;
      toolSessionId?: string;
      welinkSessionId?: string;
      code?: string;
      field?: string;
      reason?: string;
    };

/**
 * terminal 生命周期观测事件。
 */
export type TerminalObservationEvent = {
  type: 'terminal_progress';
  phase: 'received' | 'projected';
  toolSessionId: string;
  welinkSessionId?: string;
  runId?: string;
  result: ProviderTerminalResult;
};

/**
 * 失败收口观测事件。
 */
export type FailureRecordedObservationEvent = {
  type: 'failure_recorded';
  kind: RuntimeFailureKind;
  phase: RuntimeFailurePhase;
  message: string;
  code?: string;
};

/**
 * runtime 统一观测事件闭集。
 */
export type RuntimeObservationEvent =
  | RuntimeLifecycleObservationEvent
  | GatewayStateChangedObservationEvent
  | GatewayActivityObservationEvent
  | GatewayProbeObservationEvent
  | DownstreamReceivedObservationEvent
  | DownstreamProcessedObservationEvent
  | CommandDispatchedObservationEvent
  | UsecaseProgressObservationEvent
  | ProviderCallObservationEvent
  | FactProcessedObservationEvent
  | InteractionChangedObservationEvent
  | UplinkObservationEvent
  | TerminalObservationEvent
  | FailureRecordedObservationEvent;

export type RuntimeObservationMessageSummary = {
  messageType: GatewayDownstreamBusinessRequest['type'];
  action?: string;
  toolSessionId?: string;
  welinkSessionId?: string;
};

export type RuntimeObservationCommandContext = {
  toolSessionId?: string;
  welinkSessionId?: string;
};

export type RuntimeObservationUsecaseContext = RuntimeObservationCommandContext & {
  runId?: string;
  outcome?: ProviderTerminalResult['outcome'];
};

export type RuntimeObservationProviderContext = {
  toolSessionId?: string;
  runId?: string;
  welinkSessionId?: string;
};

export type RuntimeObservationTerminalContext = {
  welinkSessionId?: string;
  runId?: string;
};
