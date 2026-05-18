import type { RegisterMessage } from '@agent-plugin/gateway-schema';

/**
 * Gateway register 报文所需输入。
 * @remarks 该层只负责按调用方已解析好的元数据组包，不在此处裁决
 * `sdkVersion` / `pluginVersion` 的场景语义；最终协议合法性以 gateway-schema 为准。
 */
export interface GatewayRegisterMessageInput {
  deviceName: string;
  os: string;
  toolType: string;
  toolVersion: string;
  sdkVersion?: string;
  pluginVersion?: string;
  macAddress?: string;
}

/**
 * 统一装配 register 报文；调用方负责先完成元数据推导。
 * @remarks 该函数不在本地重复实现完整协议约束，避免 gateway-client 重新拥有一份
 * register 语义真源；最终字段合法性由 gateway-schema 校验收口。
 */
export function buildGatewayRegisterMessage(input: GatewayRegisterMessageInput): RegisterMessage {
  const macAddress = input.macAddress;
  const hasUsableMacAddress = !!macAddress?.trim();

  return {
    type: 'register',
    deviceName: input.deviceName,
    os: input.os,
    toolType: input.toolType,
    toolVersion: input.toolVersion,
    ...(input.sdkVersion ? { sdkVersion: input.sdkVersion } : {}),
    ...(input.pluginVersion ? { pluginVersion: input.pluginVersion } : {}),
    ...(hasUsableMacAddress ? { macAddress } : {}),
  };
}
