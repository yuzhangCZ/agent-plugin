import { DefaultGatewayClient } from '../application/DefaultGatewayClient.ts';
import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientConfig } from '../ports/GatewayClientConfig.ts';
import type { GatewayClientOverrides } from '../ports/GatewayClientOverrides.ts';
import { createGatewayRuntimeDependencies } from './createGatewayRuntimeDependencies.ts';

/**
 * 创建可注入测试替身依赖的 GatewayClient。
 * @remarks 仅测试场景使用，用于覆写重连、编解码与 transport 依赖。
 */
export function createGatewayClientForTesting(
  config: GatewayClientConfig,
  overrides: GatewayClientOverrides = {},
): GatewayClient {
  const options = { ...config, ...overrides };
  return new DefaultGatewayClient(options, createGatewayRuntimeDependencies(options));
}
