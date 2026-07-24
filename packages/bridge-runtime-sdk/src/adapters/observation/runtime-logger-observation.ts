import type { BridgeGatewayLogger } from '../../infrastructure/gateway/gateway-host.ts';
import type {
  GatewayProbeObservationEvent,
  RuntimeObservationEvent,
  RuntimeObservationPort,
} from '../../application/runtime-observation/index.ts';

type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['ak', 'sk', 'token', 'authorization', 'cookie', 'secret', 'password', 'content', 'text', 'answers'];
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lower = key.toLowerCase();
    if (sensitiveKeys.some((item) => lower.includes(item))) {
      output[key] = '***';
      continue;
    }
    output[key] = value;
  }
  return output;
}

function write(
  logger: BridgeGatewayLogger | undefined,
  level: RuntimeLogLevel,
  message: string,
  meta: Record<string, unknown>,
): void {
  logger?.[level]?.(message, redactMeta(meta));
}

function getGatewayProbeLogLevel(event: GatewayProbeObservationEvent): RuntimeLogLevel {
  if (event.phase !== 'completed') {
    return 'info';
  }
  if (event.state === 'connect_error') {
    return 'error';
  }
  if (event.state === 'timeout' || event.state === 'rejected') {
    return 'warn';
  }
  return 'info';
}

function getRuntimeLifecycleCategory(action: Extract<RuntimeObservationEvent, { type: 'runtime_lifecycle' }>['action']): string {
  if (action.startsWith('start')) {
    return 'start';
  }
  if (action.startsWith('stop')) {
    return 'stop';
  }
  return 'core';
}

function getDownstreamProcessedLogLevel(action: Extract<RuntimeObservationEvent, { type: 'downstream_processed' }>['action']): RuntimeLogLevel {
  if (action === 'failed') {
    return 'error';
  }
  if (action === 'invalid_invoke_rejected') {
    return 'warn';
  }
  return 'info';
}

function getUsecaseProgressLogLevel(phase: Extract<RuntimeObservationEvent, { type: 'usecase_progress' }>['phase']): RuntimeLogLevel {
  if (phase === 'failed') {
    return 'error';
  }
  if (phase === 'conflict') {
    return 'warn';
  }
  return 'info';
}

function getProviderCallLogLevel(phase: Extract<RuntimeObservationEvent, { type: 'provider_call' }>['phase']): RuntimeLogLevel {
  if (phase === 'failed') {
    return 'error';
  }
  if (phase === 'started') {
    return 'debug';
  }
  return 'info';
}

function getFactProcessedMeta(event: Extract<RuntimeObservationEvent, { type: 'fact_processed' }>): Record<string, unknown> {
  if (event.phase === 'received') {
    return {
      toolSessionId: event.toolSessionId,
      factType: event.fact.type,
      profile: event.profile,
    };
  }
  if (event.phase === 'derived_event_projected') {
    return {
      toolSessionId: event.toolSessionId,
      factType: event.factType,
      eventType: event.event.type,
      profile: event.profile,
    };
  }
  return {
    toolSessionId: event.toolSessionId,
    factType: event.factType,
    uplinkType: event.uplinkType,
    profile: event.profile,
  };
}

function getInteractionActionName(action: Extract<RuntimeObservationEvent, { type: 'interaction_changed' }>['action']): string {
  if (action === 'consume') {
    return 'consumed';
  }
  if (action === 'register') {
    return 'registered';
  }
  return 'conflict';
}

function getFailureRecordedLogLevel(kind: Extract<RuntimeObservationEvent, { type: 'failure_recorded' }>['kind']): RuntimeLogLevel {
  if (kind === 'inbound_validation_failure' || kind === 'outbound_validation_failure') {
    return 'warn';
  }
  return 'error';
}

/**
 * 把 observation event 投影为宿主结构化日志。
 */
export class BridgeGatewayLoggerObservationAdapter implements RuntimeObservationPort {
  private readonly logger?: BridgeGatewayLogger;

  constructor(logger?: BridgeGatewayLogger) {
    this.logger = logger;
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- observation 日志投影按事件类型集中分派，保持日志命名在单一出口维护。
  record(event: RuntimeObservationEvent): void {
    switch (event.type) {
      case 'runtime_lifecycle':
        write(
          this.logger,
          event.action.endsWith('failed') ? 'error' : 'info',
          `runtime_sdk.${getRuntimeLifecycleCategory(event.action)}.${event.action.replace(/^(start_|stop_|core_)/, '')}`,
          {
            failureReason: event.failureReason,
            code: event.code,
          },
        );
        return;
      case 'gateway_state_changed':
        write(this.logger, 'info', 'runtime_sdk.gateway.state_changed', {
          gatewayState: event.state,
        });
        return;
      case 'gateway_probe':
        write(
          this.logger,
          getGatewayProbeLogLevel(event),
          `runtime_sdk.gateway_probe.${event.phase}`,
          event.phase === 'requested'
            ? {
                gatewayUrl: event.gatewayUrl,
                timeoutMs: event.timeoutMs,
              }
            : {
                gatewayUrl: event.gatewayUrl,
                state: event.state,
                latencyMs: event.latencyMs,
                reason: event.reason,
              },
        );
        return;
      case 'downstream_received':
        write(this.logger, 'info', 'runtime_sdk.downstream.received', {
          messageType: event.messageType,
          action: event.action,
          toolSessionId: event.toolSessionId,
          welinkSessionId: event.welinkSessionId,
        });
        return;
      case 'downstream_processed':
        write(
          this.logger,
          getDownstreamProcessedLogLevel(event.action),
          `runtime_sdk.downstream.${event.action}`,
          {
            messageType: event.messageType,
            command: event.command,
            toolSessionId: event.toolSessionId,
            welinkSessionId: event.welinkSessionId,
            error: event.error,
            code: event.code,
          },
        );
        return;
      case 'command_dispatched':
        write(
          this.logger,
          event.phase === 'failed' ? 'error' : 'info',
          `runtime_sdk.command.${event.phase === 'dispatched' ? 'dispatched' : event.phase}`,
          {
            traceId: event.traceId,
            command: event.command,
            toolSessionId: event.toolSessionId,
            welinkSessionId: event.welinkSessionId,
            error: event.error,
            code: event.code,
          },
        );
        return;
      case 'usecase_progress':
        write(
          this.logger,
          getUsecaseProgressLogLevel(event.phase),
          `runtime_sdk.usecase.${event.usecase}.${event.phase}`,
          {
            traceId: event.traceId,
            toolSessionId: event.toolSessionId,
            welinkSessionId: event.welinkSessionId,
            runId: event.runId,
            activeRunChatPolicy: event.activeRunChatPolicy,
            activeRunIds: event.activeRunIds,
            outcome: event.outcome,
            error: event.error,
            code: event.code,
          },
        );
        return;
      case 'provider_call':
        write(
          this.logger,
          getProviderCallLogLevel(event.phase),
          `runtime_sdk.provider.${event.command}.${event.phase}`,
          {
            traceId: event.traceId,
            toolSessionId: event.toolSessionId,
            runId: event.runId,
            slashCommandCount: event.slashCommandCount,
            slashCommands: event.slashCommands,
            error: event.error,
            code: event.code,
          },
        );
        return;
      case 'fact_processed':
        write(
          this.logger,
          'debug',
          `runtime_sdk.fact.${event.phase}`,
          getFactProcessedMeta(event),
        );
        return;
      case 'interaction_changed':
        write(
          this.logger,
          event.action === 'conflict' ? 'warn' : 'info',
          `runtime_sdk.interaction.${getInteractionActionName(event.action)}`,
          {
            kind: event.kind,
            toolSessionId: event.toolSessionId,
            tokenId: event.tokenId,
            conflictingToolSessionId: event.conflictingToolSessionId,
          },
        );
        return;
      case 'uplink_emitted':
        return;
      case 'uplink_validation':
        write(
          this.logger,
          event.phase === 'validation_failed' ? 'warn' : 'info',
          `runtime_sdk.uplink.${event.phase}`,
          {
            messageType: event.messageType,
            eventType: event.eventType,
            toolSessionId: event.toolSessionId,
            welinkSessionId: event.welinkSessionId,
            code: event.code,
            field: event.field,
            reason: event.reason,
          },
        );
        return;
      case 'terminal_progress':
        write(
          this.logger,
          'info',
          `runtime_sdk.terminal.${event.phase}`,
          {
            toolSessionId: event.toolSessionId,
            welinkSessionId: event.welinkSessionId,
            runId: event.runId,
            outcome: event.result.outcome,
          },
        );
        return;
      case 'failure_recorded':
        write(
          this.logger,
          getFailureRecordedLogLevel(event.kind),
          'runtime_sdk.failure.recorded',
          {
            kind: event.kind,
            phase: event.phase,
            message: event.message,
            code: event.code,
          },
        );
        return;
      case 'gateway_activity':
        return;
      default:
        return;
    }
  }
}
