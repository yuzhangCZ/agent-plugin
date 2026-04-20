import type { RegisterMessage } from '@agent-plugin/gateway-schema';

/**
 * Gateway register 报文所需输入。
 */
export interface GatewayRegisterMessageInput {
  deviceName: string;
  os: string;
  toolType: string;
  toolVersion: string;
  macAddress?: string;
}

/**
 * 统一装配 register 报文；调用方负责先完成元数据推导。
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
    ...(hasUsableMacAddress ? { macAddress } : {}),
  };
}
