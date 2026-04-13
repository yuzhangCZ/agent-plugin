import {
  buildGatewayRegisterMessage,
  createAkSkAuthProvider,
  type GatewayClientConfig,
} from "@agent-plugin/gateway-client";
import os from "node:os";
import type { RegisterMetadata } from "./runtime/RegisterMetadata.js";
import type { BridgeLogger, MessageBridgeResolvedAccount } from "./types.js";

/**
 * 统一构造 openclaw 侧 GatewayClient 配置，避免 bridge/probe 两条链路重复维护同一协议字段。
 */
export function buildGatewayClientConfig(
  account: MessageBridgeResolvedAccount,
  logger: BridgeLogger,
  registerMetadata: RegisterMetadata,
): GatewayClientConfig {
  return {
    url: account.gateway.url,
    reconnect: {
      baseMs: account.gateway.reconnect.baseMs,
      maxMs: account.gateway.reconnect.maxMs,
      exponential: account.gateway.reconnect.exponential,
    },
    heartbeatIntervalMs: account.gateway.heartbeatIntervalMs,
    debug: account.debug,
    authPayloadProvider: () => createAkSkAuthProvider(account.auth.ak, account.auth.sk).generateAuthPayload(),
    registerMessage: buildGatewayRegisterMessage({
      deviceName: registerMetadata.deviceName,
      os: os.platform(),
      toolType: registerMetadata.toolType,
      toolVersion: registerMetadata.toolVersion,
      macAddress: registerMetadata.macAddress,
    }),
    logger,
  };
}
