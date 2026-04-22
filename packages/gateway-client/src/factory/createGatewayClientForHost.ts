import os from 'node:os';

import type { GatewayClient } from '../ports/GatewayClient.ts';
import type { GatewayLogger } from '../ports/LoggerPort.ts';
import { createAkSkAuthProvider } from '../auth/AkSkAuthProvider.ts';
import { buildGatewayRegisterMessage } from './buildGatewayRegisterMessage.ts';
import { createGatewayClient } from './createGatewayClient.ts';

export type GatewayClientHostToolType = 'openx' | 'openclaw' | 'opencode';

/**
 * 宿主创建 gateway 连接所需的稳定高层配置。
 * @remarks deviceName、os、macAddress 属于本机环境身份，由 gateway-client 统一探测并装配。
 */
export interface GatewayClientHostConfig {
  url: string;
  auth: {
    ak: string;
    sk: string;
  };
  register: {
    toolType: GatewayClientHostToolType;
    toolVersion: string;
  };
}

/**
 * host-level gateway client 的运行期覆写项。
 */
export interface GatewayClientHostOptions {
  logger?: GatewayLogger;
  debug?: boolean;
  abortSignal?: AbortSignal;
}

interface GatewayHostEnvironment {
  hostname(): string;
  platform(): NodeJS.Platform;
  networkInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

function isUsableMacAddress(macAddress: string | undefined): macAddress is string {
  return !!macAddress && macAddress !== '00:00:00:00:00:00';
}

function detectMacAddress(networkInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | undefined {
  for (const interfaces of Object.values(networkInterfaces)) {
    for (const networkInterface of interfaces ?? []) {
      if (networkInterface.internal) {
        continue;
      }
      if (isUsableMacAddress(networkInterface.mac)) {
        return networkInterface.mac;
      }
    }
  }
  return undefined;
}

function resolveDeviceName(hostname: string): string {
  const trimmed = hostname.trim();
  return trimmed || 'unknown-device';
}

/**
 * 由 host-level 配置装配 register message。
 * @remarks 导出供包内测试锁定环境探测行为；稳定入口仍是 createGatewayClientForHost。
 */
export function buildGatewayHostRegisterMessage(
  register: GatewayClientHostConfig['register'],
  environment: GatewayHostEnvironment = os,
) {
  const macAddress = detectMacAddress(environment.networkInterfaces());

  return buildGatewayRegisterMessage({
    deviceName: resolveDeviceName(environment.hostname()),
    os: environment.platform(),
    toolType: register.toolType,
    toolVersion: register.toolVersion,
    ...(macAddress ? { macAddress } : {}),
  });
}

/**
 * 创建 host-level GatewayClient。
 * @remarks 这是上层 runtime SDK 使用的 gateway bootstrap 适配器，统一收口 auth 与 register 装配规则。
 */
export function createGatewayClientForHost(
  config: GatewayClientHostConfig,
  options: GatewayClientHostOptions = {},
): GatewayClient {
  const authProvider = createAkSkAuthProvider(config.auth.ak, config.auth.sk);

  return createGatewayClient({
    url: config.url,
    debug: options.debug,
    abortSignal: options.abortSignal,
    authPayloadProvider: () => authProvider.generateAuthPayload(),
    registerMessage: buildGatewayHostRegisterMessage(config.register),
    logger: options.logger,
  });
}
