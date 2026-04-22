import type { BridgeGatewayHostConfig } from "@agent-plugin/bridge-runtime-sdk";
import type { RegisterMetadata } from "./runtime/RegisterMetadata.js";
import type { MessageBridgeResolvedAccount } from "./types.js";

/**
 * 统一构造 openclaw 侧 gateway host 配置，避免 bridge/probe 两条链路重复维护同一协议字段。
 */
export function buildBridgeGatewayHostConfig(
  account: MessageBridgeResolvedAccount,
  registerMetadata: RegisterMetadata,
): BridgeGatewayHostConfig {
  return {
    url: account.gateway.url,
    auth: {
      ak: account.auth.ak,
      sk: account.auth.sk,
    },
    register: {
      toolType: registerMetadata.toolType,
      toolVersion: registerMetadata.toolVersion,
    },
  };
}

/**
 * OpenClaw 业务层按 gateway url + ak 判断同一连接资源，避免临时探活抢占正式 runtime。
 */
export function buildMessageBridgeResourceKey(account: MessageBridgeResolvedAccount): string {
  return `${account.gateway.url}:${account.auth.ak}`;
}
