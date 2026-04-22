import type { ReconnectPolicy } from '../../ports/ReconnectPolicy.ts';
import type { ReconnectScheduler } from '../../ports/ReconnectScheduler.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import { getErrorDetails, getErrorMessage } from '../telemetry/error-detail-mapper.ts';

/**
 * 重连编排器，负责策略决策、调度触发与 attempt 级别日志。
 */
export class ReconnectOrchestrator {
  private readonly scheduler: ReconnectScheduler;
  private readonly policy: ReconnectPolicy;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;
  private readonly reconnectEnabled: boolean;
  private readonly reconnect: () => Promise<void>;

  constructor(
    scheduler: ReconnectScheduler,
    policy: ReconnectPolicy,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
    reconnectEnabled: boolean,
    reconnect: () => Promise<void>,
  ) {
    this.scheduler = scheduler;
    this.policy = policy;
    this.context = context;
    this.state = state;
    this.reconnectEnabled = reconnectEnabled;
    this.reconnect = reconnect;
  }

  stop(): void {
    this.scheduler.cancel();
  }

  reset(): void {
    this.policy.reset();
    this.state.setReconnecting(false);
  }

  scheduleReconnect(): void {
    if (this.context.abortSignal?.aborted || !this.reconnectEnabled) {
      return;
    }

    const reconnectDecision = this.policy.scheduleNextAttempt();
    if (!reconnectDecision.ok) {
      this.context.telemetry.logReconnectExhausted(reconnectDecision.elapsedMs, reconnectDecision.maxElapsedMs);
      return;
    }

    const reconnectLogFields = {
      attempt: reconnectDecision.attempt,
      reconnectAttempts: reconnectDecision.attempt,
      delayMs: reconnectDecision.delayMs,
      elapsedMs: reconnectDecision.elapsedMs,
    };
    this.context.logger?.warn?.('gateway.reconnect.scheduled', reconnectLogFields);
    this.context.logger?.info?.('gateway.reconnect.scheduled', reconnectLogFields);
    this.state.setReconnecting(true);

    this.scheduler.schedule(async () => {
      if (this.state.isManuallyDisconnected() || this.context.abortSignal?.aborted) {
        this.state.setReconnecting(false);
        return;
      }

      const exhaustedDecision = this.policy.getExhaustedDecision();
      if (exhaustedDecision) {
        this.state.setReconnecting(false);
        this.context.telemetry.logReconnectExhausted(exhaustedDecision.elapsedMs, exhaustedDecision.maxElapsedMs);
        return;
      }

      try {
        this.context.logger?.info?.('gateway.reconnect.attempt', {
          attempt: reconnectDecision.attempt,
          reconnectAttempts: reconnectDecision.attempt,
        });
        await this.reconnect();
      } catch (error) {
        this.state.setReconnecting(false);
        this.context.logger?.warn?.('gateway.reconnect.failed', {
          attempt: reconnectDecision.attempt,
          reconnectAttempts: reconnectDecision.attempt,
          error: getErrorMessage(error),
          ...getErrorDetails(error),
        });
      }
    }, reconnectDecision.delayMs);
  }
}
