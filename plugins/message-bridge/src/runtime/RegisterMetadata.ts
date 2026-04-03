import os from 'os';
import type { BridgeLogger } from './AppLogger.js';

export interface RegisterMetadata {
  deviceName: string;
  toolVersion: string;
  macAddress?: string;
}

const ZERO_MAC_ADDRESS = '00:00:00:00:00:00';
const MAC_ADDRESS_PATTERN = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

function normalizeMacAddress(macAddress: string): string {
  return macAddress.trim().replace(/-/g, ':').toLowerCase();
}

function isUsableMacAddress(macAddress: string | undefined): macAddress is string {
  if (!macAddress) {
    return false;
  }

  const normalized = normalizeMacAddress(macAddress);
  return MAC_ADDRESS_PATTERN.test(normalized) && normalized !== ZERO_MAC_ADDRESS;
}

function resolveMacAddress(logger: BridgeLogger): string | undefined {
  const interfaces = os.networkInterfaces();
  let interfaceCount = 0;

  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }

    interfaceCount += entries.length;
    for (const entry of entries) {
      if (entry.internal || !isUsableMacAddress(entry.mac)) {
        continue;
      }
      return normalizeMacAddress(entry.mac);
    }
  }

  logger.warn('runtime.mac_address.unavailable', {
    platform: os.platform(),
    interfaceCount,
  });
  return undefined;
}

export function resolveRegisterMetadata(toolVersion: string, logger: BridgeLogger): RegisterMetadata {
  const macAddress = resolveMacAddress(logger);
  return {
    deviceName: os.hostname(),
    toolVersion,
    ...(macAddress ? { macAddress } : {}),
  };
}
