import { RuntimeTraceCollector, type RuntimeDiagnostics } from '../../application/runtime-trace.ts';
import type { RuntimeObservationEvent, RuntimeObservationPort } from '../../application/runtime-observation/index.ts';

/**
 * 把 observation event 投影为 runtime diagnostics。
 */
export class RuntimeTraceCollectorAdapter implements RuntimeObservationPort {
  private readonly trace: RuntimeTraceCollector;

  constructor(trace = new RuntimeTraceCollector()) {
    this.trace = trace;
  }

  // eslint-disable-next-line complexity -- trace observation adapter 按事件类型集中分派 diagnostics 投影，保持诊断写入入口单一。
  record(event: RuntimeObservationEvent): void {
    switch (event.type) {
      case 'provider_call':
        this.recordProviderCall(event);
        return;
      case 'fact_processed':
        if (event.phase === 'received') {
          this.trace.recordFact(event.toolSessionId, event.fact);
          return;
        }
        if (event.phase === 'derived_event_projected') {
          this.trace.recordDerivedEvent(event.toolSessionId, event.event);
        }
        return;
      case 'interaction_changed':
        if (event.action !== 'conflict') {
          this.trace.recordInteraction({
            action: event.action,
            kind: event.kind,
            toolSessionId: event.toolSessionId,
            tokenId: event.tokenId,
          });
        }
        return;
      case 'uplink_emitted':
        this.trace.recordUplink(event.message);
        return;
      case 'terminal_progress':
        if (event.phase === 'received') {
          this.trace.recordTerminal(event.toolSessionId, event.result);
        }
        return;
      case 'failure_recorded':
        this.trace.recordFailure({
          kind: event.kind,
          phase: event.phase,
          message: event.message,
          code: event.code,
        });
        return;
      case 'gateway_state_changed':
        this.trace.recordGatewayState(event.state);
        if (event.state === 'ready') {
          this.trace.recordReadyAt(event.occurredAt ?? Date.now());
        }
        return;
      case 'gateway_activity':
        if (event.activity === 'inbound') {
          this.trace.recordInboundAt(event.occurredAt ?? Date.now());
          return;
        }
        if (event.activity === 'outbound') {
          this.trace.recordOutboundAt(event.occurredAt ?? Date.now());
          return;
        }
        this.trace.recordHeartbeatAt(event.occurredAt ?? Date.now());
        return;
      default:
        return;
    }
  }

  private recordProviderCall(event: Extract<RuntimeObservationEvent, { type: 'provider_call' }>): void {
    if (event.phase !== 'started') {
      return;
    }

    this.trace.recordProviderCall({
      command: event.command,
      ...(event.toolSessionId ? { toolSessionId: event.toolSessionId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.runIds ? { runIds: event.runIds } : {}),
    });
  }

  snapshot(): RuntimeDiagnostics {
    return this.trace.snapshot();
  }
}
