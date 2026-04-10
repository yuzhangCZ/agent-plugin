import { DefaultGatewayClient } from '../application/DefaultGatewayClient.ts';
import { createGatewayRuntimeDependencies } from '../factory/createGatewayRuntimeDependencies.ts';
import type { GatewayClientConfig } from '../ports/GatewayClientConfig.ts';

export { GatewayClientError } from '../errors/GatewayClientError.ts';
export type { GatewayClient as GatewayConnection } from '../ports/GatewayClient.ts';
export type { GatewayClientEvents as GatewayConnectionEvents } from '../ports/GatewayClientEvents.ts';
export type { GatewayClientConfig as GatewayConnectionOptions } from '../ports/GatewayClientConfig.ts';
export type { GatewaySendContext as GatewaySendLogContext } from '../domain/send-context.ts';
export type { GatewayClientState as ConnectionState } from '../domain/state.ts';

/**
 * 向后兼容的连接类别名，行为与 DefaultGatewayClient 保持一致。
 */
export class DefaultGatewayConnection extends DefaultGatewayClient {
  constructor(options: GatewayClientConfig) {
    super(options, createGatewayRuntimeDependencies(options));
  }
}
