import { DefaultGatewayClient } from '../application/DefaultGatewayClient.ts';
import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayClientConfig } from '../ports/GatewayClientConfig.ts';
import { createGatewayRuntimeDependencies } from './createGatewayRuntimeDependencies.ts';

/**
 * 创建面向业务侧的默认 GatewayClient facade。
 * @param config 网关连接基础配置。
 * @returns 可直接用于 connect/send/disconnect 的客户端实例。
 */
export function createGatewayClient(config: GatewayClientConfig): GatewayClient {
  return new DefaultGatewayClient(config, createGatewayRuntimeDependencies(config));
}
