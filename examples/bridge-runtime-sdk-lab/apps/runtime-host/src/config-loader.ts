import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SafeGatewayConfig } from '@agent-plugin/bridge-runtime-sdk-lab-shared';
import type { BridgeGatewayHostConfig } from '@wecode/bridge-runtime-sdk';
import { parse } from 'jsonc-parser';

import { asRecord } from './sanitize.ts';

export interface GatewayConfigOverrides {
  url?: string;
  channel?: string;
  toolVersion?: string;
  pluginVersion?: string;
}

export interface LoadGatewayConfigInput {
  workspaceRoot: string;
  configPath?: string;
  overrides?: GatewayConfigOverrides;
}

const DEFAULT_TOOL_VERSION = 'sdk-lab';
const DEFAULT_PLUGIN_VERSION = 'sdk-lab';

export async function loadGatewayConfig(input: LoadGatewayConfigInput): Promise<BridgeGatewayHostConfig> {
  const configPath = input.configPath ?? join(input.workspaceRoot, '.opencode', 'message-bridge.jsonc');
  const content = await readFile(configPath, 'utf8');
  const parsed = parse(content);
  const root = asRecord(parsed);
  const gateway = asRecord(root?.gateway);
  const auth = asRecord(root?.auth);
  const url = optionalString(input.overrides?.url) ?? optionalString(gateway?.url);
  const channel = optionalString(input.overrides?.channel) ?? requiredString(gateway?.channel, 'gateway.channel');
  const ak = requiredString(auth?.ak, 'auth.ak');
  const sk = requiredString(auth?.sk, 'auth.sk');

  return {
    url,
    auth: {
      ak,
      sk,
    },
    register: {
      channel,
      toolVersion: optionalString(input.overrides?.toolVersion) ?? DEFAULT_TOOL_VERSION,
      pluginVersion: optionalString(input.overrides?.pluginVersion) ?? DEFAULT_PLUGIN_VERSION,
    },
  };
}

export function toSafeGatewayConfig(config: BridgeGatewayHostConfig): SafeGatewayConfig {
  return {
    url: config.url,
    authLoaded: Boolean(config.auth.ak && config.auth.sk),
    register: {
      channel: config.register.channel,
      toolVersion: config.register.toolVersion,
      pluginVersion: config.register.pluginVersion,
    },
  };
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required gateway config field: ${path}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value;
}
