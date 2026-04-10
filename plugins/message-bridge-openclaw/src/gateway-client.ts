import os from "node:os";
import {
  createAkSkAuthProvider,
  type GatewayClientConfig,
} from "@agent-plugin/gateway-client";
import { UPSTREAM_MESSAGE_TYPE } from "./gateway-wire/transport.js";
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
    registerMessage: {
      type: UPSTREAM_MESSAGE_TYPE.REGISTER,
      deviceName: registerMetadata.deviceName,
      os: os.platform(),
      toolType: registerMetadata.toolType,
      toolVersion: registerMetadata.toolVersion,
      ...(registerMetadata.macAddress ? { macAddress: registerMetadata.macAddress } : {}),
    },
    logger,
  };
}
