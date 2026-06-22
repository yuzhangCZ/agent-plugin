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
          `runtime_sdk.${event.action.startsWith('start') ? 'start' : event.action.startsWith('stop') ? 'stop' : 'core'}.${event.action.replace(/^(start_|stop_|core_)/, '')}`,
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
          event.action === 'failed' ? 'error' : event.action === 'invalid_invoke_rejected' ? 'warn' : 'info',
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
          event.phase === 'failed' ? 'error' : event.phase === 'conflict' ? 'warn' : 'info',
          `runtime_sdk.usecase.${event.usecase}.${event.phase}`,
          {
            traceId: event.traceId,
            toolSessionId: event.toolSessionId,
            welinkSessionId: event.welinkSessionId,
            runId: event.runId,
            outcome: event.outcome,
            error: event.error,
            code: event.code,
          },
        );
        return;
      case 'provider_call':
        write(
          this.logger,
          event.phase === 'failed' ? 'error' : event.phase === 'started' ? 'debug' : 'info',
          `runtime_sdk.provider.${event.command}.${event.phase}`,
          {
            traceId: event.traceId,
            toolSessionId: event.toolSessionId,
            runId: event.runId,
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
          event.phase === 'received'
            ? {
                toolSessionId: event.toolSessionId,
                factType: event.fact.type,
                profile: event.profile,
              }
            : event.phase === 'derived_event_projected'
              ? {
                  toolSessionId: event.toolSessionId,
                  factType: event.factType,
                  eventType: event.event.type,
                  profile: event.profile,
                }
              : {
                  toolSessionId: event.toolSessionId,
                  factType: event.factType,
                  uplinkType: event.uplinkType,
                  profile: event.profile,
                },
        );
        return;
      case 'interaction_changed':
        write(
          this.logger,
          event.action === 'conflict' ? 'warn' : 'info',
          `runtime_sdk.interaction.${event.action === 'consume' ? 'consumed' : event.action === 'register' ? 'registered' : 'conflict'}`,
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
          event.kind === 'inbound_validation_failure' || event.kind === 'outbound_validation_failure' ? 'warn' : 'error',
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
      // no default
    }
  }
}
