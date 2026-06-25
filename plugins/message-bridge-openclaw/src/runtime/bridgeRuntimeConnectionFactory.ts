import type { BridgeGatewayHostConfig, BridgeRuntimeOptions } from "@wecode/bridge-runtime-sdk";

/**
 * 仅用于 OpenClaw 装配层的 gateway connection 最小能力面。
 * @remarks 这里对齐 bridge-runtime 内部测试缝实际依赖的方法集合，
 * 避免把 connectionFactory 退化成 unknown。
 */
export interface BridgeRuntimeConnectionLike {
  connect(): Promise<void>;
  disconnect(): void;
  send(message: unknown): void;
  isConnected(): boolean;
  getState(): string;
  getStatus(): { isReady(): boolean };
  on(event: string, listener: (...args: unknown[]) => void): BridgeRuntimeConnectionLike;
}

export type BridgeRuntimeConnectionFactory = (
  gatewayHost: BridgeGatewayHostConfig,
) => BridgeRuntimeConnectionLike;

type BridgeRuntimeOptionsWithConnectionFactory = BridgeRuntimeOptions & {
  connectionFactory?: BridgeRuntimeConnectionFactory;
};

/**
 * 仅在宿主显式注入测试 seam 时附加 connectionFactory，避免污染默认公开配置。
 */
export function withOptionalConnectionFactory(
  options: BridgeRuntimeOptions,
  connectionFactory?: BridgeRuntimeConnectionFactory,
): BridgeRuntimeOptionsWithConnectionFactory {
  if (!connectionFactory) {
    return options;
  }
  return {
    ...options,
    connectionFactory,
  };
}
