import { DEFAULT_EVENT_ALLOWLIST } from '../contracts/upstream-events.js';
import type { BridgeConfig } from '../types/index.js';
import { DEFAULT_GATEWAY_URL } from './default-gateway-url.js';

export const DEFAULT_BRIDGE_CONFIG = {
  enabled: true,
  debug: false,
  bridgeDirectory: undefined,
  config_version: 1,
  gateway: {
    url: DEFAULT_GATEWAY_URL,
    channel: 'openx',
    heartbeatIntervalMs: 30000,
    reconnect: {
      baseMs: 1000,
      maxMs: 30000,
      exponential: true,
    },
    ping: {
      intervalMs: 30000,
    },
  },
  sdk: {
    timeoutMs: 10000,
  },
  auth: {
    ak: '',
    sk: '',
  },
  events: {
    allowlist: [...DEFAULT_EVENT_ALLOWLIST],
  },
} satisfies BridgeConfig;
