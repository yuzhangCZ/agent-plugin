import { HEARTBEAT_MESSAGE_TYPE, type HeartbeatMessage } from '@agent-plugin/gateway-schema';

import type { HeartbeatScheduler } from '../../ports/HeartbeatScheduler.ts';
import type { GatewayRuntimeContext, GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';
import { OutboundSender } from './OutboundSender.ts';
import { getErrorDetails, getErrorMessage } from '../telemetry/error-detail-mapper.ts';

/**
 * 心跳循环编排器，负责 READY 后的周期心跳发送。
 */
export class HeartbeatLoop {
  private readonly scheduler: HeartbeatScheduler;
  private readonly sender: OutboundSender;
  private readonly context: GatewayRuntimeContext;
  private readonly state: GatewayRuntimeStatePort;

  constructor(
    scheduler: HeartbeatScheduler,
    sender: OutboundSender,
    context: GatewayRuntimeContext,
    state: GatewayRuntimeStatePort,
  ) {
    this.scheduler = scheduler;
    this.sender = sender;
    this.context = context;
    this.state = state;
  }

  start(): void {
    const heartbeatIntervalMs = this.context.options.heartbeatIntervalMs ?? 30000;
    this.scheduler.start(() => {
      if (!this.state.isConnected()) {
        return;
      }
      const heartbeat: HeartbeatMessage = {
        type: HEARTBEAT_MESSAGE_TYPE,
        timestamp: new Date().toISOString(),
      };
      try {
        this.sender.sendInternalControl(heartbeat);
        this.context.logger?.debug?.('gateway.heartbeat.sent');
      } catch (error) {
        this.context.logger?.error?.('gateway.heartbeat.failed', {
          error: getErrorMessage(error),
          ...getErrorDetails(error),
        });
      }
    }, heartbeatIntervalMs);
  }

  stop(): void {
    this.scheduler.stop();
  }
}
