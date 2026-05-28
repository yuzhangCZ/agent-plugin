import type {
  FailureRecordedObservationEvent,
  RuntimeObservationCommand,
  RuntimeObservationCommandContext,
  RuntimeObservationEvent,
  RuntimeObservationMessageSummary,
  RuntimeObservationProviderCommand,
  RuntimeObservationProviderContext,
  RuntimeObservationTerminalContext,
  RuntimeObservationUsecaseContext,
} from './runtime-observation.types.ts';
import type { GatewayUplinkBusinessMessage, SkillProviderEvent } from '@agent-plugin/gateway-schema';
import type { ProviderFact, ProviderTerminalResult } from '../../domain/provider.ts';

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
  factReceived(toolSessionId: string, fact: ProviderFact, profile: 'request_run' | 'outbound'): void;
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
