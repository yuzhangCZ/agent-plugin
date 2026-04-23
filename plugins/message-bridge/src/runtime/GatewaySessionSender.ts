import type {
  GatewayClient,
  GatewaySendContext as GatewaySendLogContext,
  GatewaySendPayload,
} from '@agent-plugin/gateway-client';

import type { BridgeLogger } from './AppLogger.js';

export interface GatewaySessionSenderPort {
  sendIfActive(
    connection: GatewayClient,
    payload: GatewaySendPayload,
    context: GatewaySendLogContext,
  ): boolean;
}

export interface GatewaySessionSenderOptions {
  getActiveConnection: () => GatewayClient | null;
  getLogger: () => BridgeLogger;
}

/**
 * gateway 统一发送出口。
 * @remarks 所有 runtime -> gateway 的业务发送都必须经过这里，确保 stop/replace 后旧 connection fail-closed。
 */
export class DefaultGatewaySessionSender implements GatewaySessionSenderPort {
  private readonly getActiveConnection: () => GatewayClient | null;
  private readonly getLogger: () => BridgeLogger;

  constructor(options: GatewaySessionSenderOptions) {
    this.getActiveConnection = options.getActiveConnection;
    this.getLogger = options.getLogger;
  }

  sendIfActive(
    connection: GatewayClient,
    payload: GatewaySendPayload,
    context: GatewaySendLogContext,
  ): boolean {
    if (this.getActiveConnection() !== connection) {
      this.getLogger().warn('runtime.send.skipped_stale_connection', {
        gatewayMessageId: context.gatewayMessageId,
        welinkSessionId: context.welinkSessionId,
        toolSessionId: context.toolSessionId,
        action: context.action,
        messageType: payload.type,
      });
      return false;
    }

    connection.send(payload, context);
    return true;
  }
}
