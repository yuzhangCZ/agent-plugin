import type { GatewayDownstreamBusinessRequest, GatewayUplinkBusinessMessage, SkillProviderEvent } from '@agent-plugin/gateway-schema';

import type { ProviderFact, ProviderTerminalResult } from '../domain/provider.ts';

/**
 * runtime command 名称闭集。
 */
export type RuntimeObservationCommand =
  | 'query_status'
  | 'create_session'
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
      profile: 'request_run' | 'outbound';
    }
  | {
      type: 'fact_processed';
      phase: 'derived_event_projected';
      toolSessionId: string;
      factType: ProviderFact['type'];
      event: SkillProviderEvent;
      profile: 'request_run' | 'outbound';
    }
  | {
      type: 'fact_processed';
      phase: 'projected';
      toolSessionId: string;
      factType: ProviderFact['type'];
      uplinkType: GatewayUplinkBusinessMessage['type'];
      profile: 'request_run' | 'outbound';
    };

/**
 * interaction 状态变化观测事件。
 */
export type InteractionChangedObservationEvent = {
  type: 'interaction_changed';
  action: 'register' | 'consume' | 'clear' | 'conflict';
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
  kind:
    | 'startup_failure'
    | 'gateway_runtime_failure'
    | 'command_execution_failure'
    | 'inbound_validation_failure'
    | 'outbound_validation_failure';
  phase: 'start' | 'runtime' | 'stop';
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
};

export type RuntimeObservationTerminalContext = {
  welinkSessionId?: string;
  runId?: string;
};

/**
 * 面向 application core 的阶段化观测 API。
 * @remarks
 * core 只调用语义方法，不直接拼接 RuntimeObservationEvent。
 */
export interface RuntimeObservation {
  runtimeStartRequested(): void;
  runtimeStartCompleted(): void;
  runtimeStartFailed(error: unknown, code?: string): void;
  runtimeStopRequested(): void;
  runtimeStopCompleted(): void;
  runtimeStopFailed(error: unknown, code?: string): void;
  runtimeCoreStarted(): void;
  runtimeCoreStopped(): void;
  gatewayStateChanged(state: string, occurredAt?: number): void;
  gatewayInboundActivity(occurredAt?: number): void;
  gatewayOutboundActivity(occurredAt?: number): void;
  gatewayHeartbeatActivity(occurredAt?: number): void;
  downstreamReceived(summary: RuntimeObservationMessageSummary): void;
  downstreamHandled(summary: RuntimeObservationMessageSummary, command: RuntimeObservationCommand): void;
  downstreamFailed(summary: RuntimeObservationMessageSummary, error: unknown, code?: string): void;
  invalidInvokeRejected(
    summary: Pick<RuntimeObservationMessageSummary, 'toolSessionId' | 'welinkSessionId'>,
    error: unknown,
    code?: string,
  ): void;
  commandDispatched(
    command: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationCommandContext,
  ): void;
  commandCompleted(
    command: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationCommandContext,
  ): void;
  commandFailed(
    command: RuntimeObservationCommand,
    traceId: string,
    error: unknown,
    code?: string,
    context?: RuntimeObservationCommandContext,
  ): void;
  usecaseStarted(
    usecase: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationUsecaseContext,
  ): void;
  usecaseSucceeded(
    usecase: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationUsecaseContext,
  ): void;
  usecaseConflict(
    usecase: RuntimeObservationCommand,
    traceId: string,
    error: unknown,
    code: string,
    context?: RuntimeObservationUsecaseContext,
  ): void;
  usecaseFailed(
    usecase: RuntimeObservationCommand,
    traceId: string,
    error: unknown,
    code?: string,
    context?: RuntimeObservationUsecaseContext,
  ): void;
  providerCallStarted(
    command: RuntimeObservationProviderCommand,
    traceId: string,
    context?: RuntimeObservationProviderContext,
  ): void;
  providerCallSucceeded(
    command: RuntimeObservationProviderCommand,
    traceId: string,
    context?: RuntimeObservationProviderContext,
  ): void;
  providerCallFailed(
    command: RuntimeObservationProviderCommand,
    traceId: string,
    error: unknown,
    code?: string,
    context?: RuntimeObservationProviderContext,
  ): void;
  factReceived(fact: ProviderFact, profile: 'request_run' | 'outbound'): void;
  derivedEventProjected(
    toolSessionId: string,
    factType: ProviderFact['type'],
    event: SkillProviderEvent,
    profile: 'request_run' | 'outbound',
  ): void;
  uplinkProjected(
    toolSessionId: string,
    factType: ProviderFact['type'],
    uplinkType: GatewayUplinkBusinessMessage['type'],
    profile: 'request_run' | 'outbound',
  ): void;
  interactionRegistered(kind: 'question' | 'permission', toolSessionId: string, tokenId: string): void;
  interactionConsumed(kind: 'question' | 'permission', toolSessionId: string, tokenId: string): void;
  interactionCleared(toolSessionId: string): void;
  interactionConflict(
    kind: 'question' | 'permission',
    toolSessionId: string,
    tokenId: string,
    conflictingToolSessionId: string,
  ): void;
  terminalReceived(toolSessionId: string, result: ProviderTerminalResult, context?: RuntimeObservationTerminalContext): void;
  terminalProjected(
    toolSessionId: string,
    result: ProviderTerminalResult,
    context?: RuntimeObservationTerminalContext,
  ): void;
  uplinkEmitted(message: GatewayUplinkBusinessMessage): void;
  uplinkSending(message: GatewayUplinkBusinessMessage): void;
  uplinkValidated(message: GatewayUplinkBusinessMessage): void;
  uplinkValidationFailed(message: GatewayUplinkBusinessMessage, code: string, field?: string, reason?: string): void;
  failureRecorded(
    kind: FailureRecordedObservationEvent['kind'],
    phase: FailureRecordedObservationEvent['phase'],
    message: string,
    code?: string,
  ): void;
}

/**
 * runtime 可观测性端口。
 * @remarks
 * application core 只发布结构化 observation event，不直接依赖 logger 或 diagnostics collector。
 */
export interface RuntimeObservationPort {
  record(event: RuntimeObservationEvent): void;
}

function normalizeErrorMessage(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 默认 observation facade；负责把阶段语义映射为标准 event。
 */
export class DefaultRuntimeObservation implements RuntimeObservation {
  private readonly port: RuntimeObservationPort;

  constructor(port: RuntimeObservationPort) {
    this.port = port;
  }

  runtimeStartRequested(): void {
    this.port.record({ type: 'runtime_lifecycle', action: 'start_requested' });
  }

  runtimeStartCompleted(): void {
    this.port.record({ type: 'runtime_lifecycle', action: 'start_completed' });
  }

  runtimeStartFailed(error: unknown, code?: string): void {
    this.port.record({
      type: 'runtime_lifecycle',
      action: 'start_failed',
      failureReason: normalizeErrorMessage(error),
      code,
    });
  }

  runtimeStopRequested(): void {
    this.port.record({ type: 'runtime_lifecycle', action: 'stop_requested' });
  }

  runtimeStopCompleted(): void {
    this.port.record({ type: 'runtime_lifecycle', action: 'stop_completed' });
  }

  runtimeStopFailed(error: unknown, code?: string): void {
    this.port.record({
      type: 'runtime_lifecycle',
      action: 'stop_failed',
      failureReason: normalizeErrorMessage(error),
      code,
    });
  }

  runtimeCoreStarted(): void {
    this.port.record({ type: 'runtime_lifecycle', action: 'core_started' });
  }

  runtimeCoreStopped(): void {
    this.port.record({ type: 'runtime_lifecycle', action: 'core_stopped' });
  }

  gatewayStateChanged(state: string, occurredAt?: number): void {
    this.port.record({ type: 'gateway_state_changed', state, occurredAt });
  }

  gatewayInboundActivity(occurredAt?: number): void {
    this.port.record({ type: 'gateway_activity', activity: 'inbound', occurredAt });
  }

  gatewayOutboundActivity(occurredAt?: number): void {
    this.port.record({ type: 'gateway_activity', activity: 'outbound', occurredAt });
  }

  gatewayHeartbeatActivity(occurredAt?: number): void {
    this.port.record({ type: 'gateway_activity', activity: 'heartbeat', occurredAt });
  }

  downstreamReceived(summary: RuntimeObservationMessageSummary): void {
    this.port.record({ type: 'downstream_received', ...summary });
  }

  downstreamHandled(summary: RuntimeObservationMessageSummary, command: RuntimeObservationCommand): void {
    this.port.record({ type: 'downstream_processed', ...summary, action: 'handled', command });
  }

  downstreamFailed(summary: RuntimeObservationMessageSummary, error: unknown, code?: string): void {
    this.port.record({
      type: 'downstream_processed',
      ...summary,
      action: 'failed',
      error: normalizeErrorMessage(error),
      code,
    });
  }

  invalidInvokeRejected(
    summary: Pick<RuntimeObservationMessageSummary, 'toolSessionId' | 'welinkSessionId'>,
    error: unknown,
    code?: string,
  ): void {
    this.port.record({
      type: 'downstream_processed',
      action: 'invalid_invoke_rejected',
      messageType: 'invoke',
      ...summary,
      error: normalizeErrorMessage(error),
      code,
    });
  }

  commandDispatched(
    command: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationCommandContext,
  ): void {
    this.port.record({ type: 'command_dispatched', phase: 'dispatched', command, traceId, ...context });
  }

  commandCompleted(
    command: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationCommandContext,
  ): void {
    this.port.record({ type: 'command_dispatched', phase: 'completed', command, traceId, ...context });
  }

  commandFailed(
    command: RuntimeObservationCommand,
    traceId: string,
    error: unknown,
    code?: string,
    context?: RuntimeObservationCommandContext,
  ): void {
    this.port.record({
      type: 'command_dispatched',
      phase: 'failed',
      command,
      traceId,
      ...context,
      error: normalizeErrorMessage(error),
      code,
    });
  }

  usecaseStarted(
    usecase: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationUsecaseContext,
  ): void {
    this.port.record({ type: 'usecase_progress', phase: 'started', usecase, traceId, ...context });
  }

  usecaseSucceeded(
    usecase: RuntimeObservationCommand,
    traceId: string,
    context?: RuntimeObservationUsecaseContext,
  ): void {
    this.port.record({ type: 'usecase_progress', phase: 'succeeded', usecase, traceId, ...context });
  }

  usecaseConflict(
    usecase: RuntimeObservationCommand,
    traceId: string,
    error: unknown,
    code: string,
    context?: RuntimeObservationUsecaseContext,
  ): void {
    this.port.record({
      type: 'usecase_progress',
      phase: 'conflict',
      usecase,
      traceId,
      ...context,
      error: normalizeErrorMessage(error),
      code,
    });
  }

  usecaseFailed(
    usecase: RuntimeObservationCommand,
    traceId: string,
    error: unknown,
    code?: string,
    context?: RuntimeObservationUsecaseContext,
  ): void {
    this.port.record({
      type: 'usecase_progress',
      phase: 'failed',
      usecase,
      traceId,
      ...context,
      error: normalizeErrorMessage(error),
      code,
    });
  }

  providerCallStarted(
    command: RuntimeObservationProviderCommand,
    traceId: string,
    context?: RuntimeObservationProviderContext,
  ): void {
    this.port.record({ type: 'provider_call', phase: 'started', command, traceId, ...context });
  }

  providerCallSucceeded(
    command: RuntimeObservationProviderCommand,
    traceId: string,
    context?: RuntimeObservationProviderContext,
  ): void {
    this.port.record({ type: 'provider_call', phase: 'succeeded', command, traceId, ...context });
  }

  providerCallFailed(
    command: RuntimeObservationProviderCommand,
    traceId: string,
    error: unknown,
    code?: string,
    context?: RuntimeObservationProviderContext,
  ): void {
    this.port.record({
      type: 'provider_call',
      phase: 'failed',
      command,
      traceId,
      ...context,
      error: normalizeErrorMessage(error),
      code,
    });
  }

  factReceived(fact: ProviderFact, profile: 'request_run' | 'outbound'): void {
    this.port.record({
      type: 'fact_processed',
      phase: 'received',
      toolSessionId: fact.toolSessionId,
      fact,
      profile,
    });
  }

  derivedEventProjected(
    toolSessionId: string,
    factType: ProviderFact['type'],
    event: SkillProviderEvent,
    profile: 'request_run' | 'outbound',
  ): void {
    this.port.record({
      type: 'fact_processed',
      phase: 'derived_event_projected',
      toolSessionId,
      factType,
      event,
      profile,
    });
  }

  uplinkProjected(
    toolSessionId: string,
    factType: ProviderFact['type'],
    uplinkType: GatewayUplinkBusinessMessage['type'],
    profile: 'request_run' | 'outbound',
  ): void {
    this.port.record({
      type: 'fact_processed',
      phase: 'projected',
      toolSessionId,
      factType,
      uplinkType,
      profile,
    });
  }

  interactionRegistered(kind: 'question' | 'permission', toolSessionId: string, tokenId: string): void {
    this.port.record({ type: 'interaction_changed', action: 'register', kind, toolSessionId, tokenId });
  }

  interactionConsumed(kind: 'question' | 'permission', toolSessionId: string, tokenId: string): void {
    this.port.record({ type: 'interaction_changed', action: 'consume', kind, toolSessionId, tokenId });
  }

  interactionCleared(toolSessionId: string): void {
    this.port.record({ type: 'interaction_changed', action: 'clear', toolSessionId });
  }

  interactionConflict(
    kind: 'question' | 'permission',
    toolSessionId: string,
    tokenId: string,
    conflictingToolSessionId: string,
  ): void {
    this.port.record({
      type: 'interaction_changed',
      action: 'conflict',
      kind,
      toolSessionId,
      tokenId,
      conflictingToolSessionId,
    });
  }

  terminalReceived(toolSessionId: string, result: ProviderTerminalResult, context?: RuntimeObservationTerminalContext): void {
    this.port.record({ type: 'terminal_progress', phase: 'received', toolSessionId, result, ...context });
  }

  terminalProjected(
    toolSessionId: string,
    result: ProviderTerminalResult,
    context?: RuntimeObservationTerminalContext,
  ): void {
    this.port.record({ type: 'terminal_progress', phase: 'projected', toolSessionId, result, ...context });
  }

  uplinkEmitted(message: GatewayUplinkBusinessMessage): void {
    this.port.record({ type: 'uplink_emitted', message });
  }

  uplinkSending(message: GatewayUplinkBusinessMessage): void {
    this.port.record({
      type: 'uplink_validation',
      phase: 'sending',
      messageType: message.type,
      toolSessionId: 'toolSessionId' in message && typeof message.toolSessionId === 'string' ? message.toolSessionId : undefined,
      welinkSessionId: 'welinkSessionId' in message && typeof message.welinkSessionId === 'string' ? message.welinkSessionId : undefined,
    });
  }

  uplinkValidated(message: GatewayUplinkBusinessMessage): void {
    this.port.record({
      type: 'uplink_validation',
      phase: 'validated',
      messageType: message.type,
      toolSessionId: 'toolSessionId' in message && typeof message.toolSessionId === 'string' ? message.toolSessionId : undefined,
      welinkSessionId: 'welinkSessionId' in message && typeof message.welinkSessionId === 'string' ? message.welinkSessionId : undefined,
    });
  }

  uplinkValidationFailed(message: GatewayUplinkBusinessMessage, code: string, field?: string, reason?: string): void {
    this.port.record({
      type: 'uplink_validation',
      phase: 'validation_failed',
      messageType: message.type,
      toolSessionId: 'toolSessionId' in message && typeof message.toolSessionId === 'string' ? message.toolSessionId : undefined,
      welinkSessionId: 'welinkSessionId' in message && typeof message.welinkSessionId === 'string' ? message.welinkSessionId : undefined,
      code,
      field,
      reason,
    });
  }

  failureRecorded(
    kind: FailureRecordedObservationEvent['kind'],
    phase: FailureRecordedObservationEvent['phase'],
    message: string,
    code?: string,
  ): void {
    this.port.record({ type: 'failure_recorded', kind, phase, message, code });
  }
}

/**
 * 组合多个 observation adapter。
 */
export class CompositeRuntimeObservationPort implements RuntimeObservationPort {
  private readonly ports: RuntimeObservationPort[];

  constructor(ports: RuntimeObservationPort[]) {
    this.ports = ports;
  }

  record(event: RuntimeObservationEvent): void {
    for (const port of this.ports) {
      port.record(event);
    }
  }
}
