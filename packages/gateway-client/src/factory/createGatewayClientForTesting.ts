import { DefaultGatewayClient } from '../application/DefaultGatewayClient.ts';
import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientConfig } from '../ports/GatewayClientConfig.ts';
import type { GatewayClientOverrides } from '../ports/GatewayClientOverrides.ts';
import { createGatewayRuntimeDependencies } from './createGatewayRuntimeDependencies.ts';

export function createGatewayClientForTesting(
  config: GatewayClientConfig,
  overrides: GatewayClientOverrides = {},
): GatewayClient {
  const options = { ...config, ...overrides };
  return new DefaultGatewayClient(options, createGatewayRuntimeDependencies(options));
}
