import type { GatewayUplinkBusinessMessage, SkillProviderEvent } from '@agent-plugin/gateway-schema';

import type { ProviderFact, ProviderTerminalResult } from '../../domain/provider.ts';
import type { LifecycleProfileKind } from '../fact-sequence-validator.ts';
import type { RuntimeObservation, RuntimeObservationPort } from './runtime-observation.port.ts';
import type {
  FailureRecordedObservationEvent,
  RequestRunPolicyObservationEvent,
  RuntimeObservationCommand,
  RuntimeObservationCommandContext,
  RuntimeObservationMessageSummary,
  RuntimeObservationProviderCommand,
  RuntimeObservationProviderContext,
  RuntimeObservationTerminalContext,
  RuntimeObservationUsecaseContext,
} from './runtime-observation.types.ts';
import type { BridgeGatewayProbeResult } from '../../infrastructure/gateway/gateway-host.ts';

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
      failureReason: this.normalizeErrorMessage(error),
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
      failureReason: this.normalizeErrorMessage(error),
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

  gatewayProbeRequested(gatewayUrl: string, timeoutMs: number): void {
    this.port.record({ type: 'gateway_probe', phase: 'requested', gatewayUrl, timeoutMs });
  }

  gatewayProbeCompleted(
    gatewayUrl: string,
    state: BridgeGatewayProbeResult['state'],
    latencyMs: number,
    reason?: string,
  ): void {
    this.port.record({ type: 'gateway_probe', phase: 'completed', gatewayUrl, state, latencyMs, reason });
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
      error: this.normalizeErrorMessage(error),
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
      error: this.normalizeErrorMessage(error),
      code,
    });
  }

  commandDispatched(command: RuntimeObservationCommand, traceId: string, context?: RuntimeObservationCommandContext): void {
    this.port.record({ type: 'command_dispatched', phase: 'dispatched', command, traceId, ...context });
  }

  commandCompleted(command: RuntimeObservationCommand, traceId: string, context?: RuntimeObservationCommandContext): void {
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
      error: this.normalizeErrorMessage(error),
      code,
    });
  }

  usecaseStarted(usecase: RuntimeObservationCommand, traceId: string, context?: RuntimeObservationUsecaseContext): void {
    this.port.record({ type: 'usecase_progress', phase: 'started', usecase, traceId, ...context });
  }

  usecaseSucceeded(usecase: RuntimeObservationCommand, traceId: string, context?: RuntimeObservationUsecaseContext): void {
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
      error: this.normalizeErrorMessage(error),
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
      error: this.normalizeErrorMessage(error),
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
      error: this.normalizeErrorMessage(error),
      code,
    });
  }

  factReceived(toolSessionId: string, fact: ProviderFact, profile: LifecycleProfileKind): void {
    this.port.record({
      type: 'fact_processed',
      phase: 'received',
      toolSessionId,
      fact,
      profile,
    });
  }

  derivedEventProjected(
    toolSessionId: string,
    factType: ProviderFact['type'],
    event: SkillProviderEvent,
    profile: LifecycleProfileKind,
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
    profile: LifecycleProfileKind,
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

  concurrentRequestRunsDetected(input: Omit<RequestRunPolicyObservationEvent, 'type' | 'action'>): void {
    this.port.record({
      type: 'request_run_policy',
      action: 'concurrent_request_runs_detected',
      ...input,
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
      eventType: this.getEventType(message),
      toolSessionId: this.getToolSessionId(message),
      welinkSessionId: this.getWelinkSessionId(message),
    });
  }

  uplinkValidated(message: GatewayUplinkBusinessMessage): void {
    this.port.record({
      type: 'uplink_validation',
      phase: 'validated',
      messageType: message.type,
      eventType: this.getEventType(message),
      toolSessionId: this.getToolSessionId(message),
      welinkSessionId: this.getWelinkSessionId(message),
    });
  }

  uplinkValidationFailed(
    message: GatewayUplinkBusinessMessage,
    code: string,
    field?: string,
    reason?: string,
    eventType?: string,
  ): void {
    this.port.record({
      type: 'uplink_validation',
      phase: 'validation_failed',
      messageType: message.type,
      eventType: eventType ?? this.getEventType(message),
      toolSessionId: this.getToolSessionId(message),
      welinkSessionId: this.getWelinkSessionId(message),
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

  private getToolSessionId(message: GatewayUplinkBusinessMessage): string | undefined {
    return 'toolSessionId' in message && typeof message.toolSessionId === 'string' ? message.toolSessionId : undefined;
  }

  private getEventType(message: GatewayUplinkBusinessMessage): string | undefined {
    return message.type === 'tool_event' ? message.event?.type : undefined;
  }

  private getWelinkSessionId(message: GatewayUplinkBusinessMessage): string | undefined {
    return 'welinkSessionId' in message && typeof message.welinkSessionId === 'string' ? message.welinkSessionId : undefined;
  }

  private normalizeErrorMessage(error: unknown): string {
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
}
