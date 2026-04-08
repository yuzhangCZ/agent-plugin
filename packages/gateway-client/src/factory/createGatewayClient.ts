import { DefaultGatewayClient } from '../application/DefaultGatewayClient.ts';
import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientConfig } from '../ports/GatewayClientConfig.ts';
import { createGatewayRuntimeDependencies } from './createGatewayRuntimeDependencies.ts';

export function createGatewayClient(config: GatewayClientConfig): GatewayClient {
  return new DefaultGatewayClient(config, createGatewayRuntimeDependencies(config));
}
