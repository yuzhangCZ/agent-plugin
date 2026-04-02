const CONSUMED_ENV_KEYS = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'BRIDGE_ENABLED',
  'BRIDGE_DEBUG',
  'BRIDGE_DIRECTORY',
  'BRIDGE_CONFIG_VERSION',
  'BRIDGE_GATEWAY_URL',
  'BRIDGE_GATEWAY_CHANNEL',
  'BRIDGE_GATEWAY_RECONNECT_BASE_MS',
  'BRIDGE_GATEWAY_RECONNECT_MAX_MS',
  'BRIDGE_GATEWAY_RECONNECT_EXPONENTIAL',
  'BRIDGE_GATEWAY_RECONNECT_JITTER',
  'BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS',
  'BRIDGE_GATEWAY_HEARTBEAT_INTERVAL_MS',
  'BRIDGE_EVENT_HEARTBEAT_INTERVAL_MS',
  'BRIDGE_GATEWAY_PING_INTERVAL_MS',
  'BRIDGE_AUTH_AK',
  'BRIDGE_AUTH_SK',
  'BRIDGE_SDK_TIMEOUT_MS',
  'BRIDGE_EVENTS_ALLOWLIST',
  'BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE',
] as const;

export interface ConsumedEnvSnapshotValue {
  present: boolean;
  value?: string;
}

export interface ConsumedEnvSnapshot {
  keys: readonly string[];
  values: Record<string, ConsumedEnvSnapshotValue>;
}

export function buildConsumedEnvSnapshot(env: NodeJS.ProcessEnv): ConsumedEnvSnapshot {
  const values: Record<string, ConsumedEnvSnapshotValue> = {};

  for (const key of CONSUMED_ENV_KEYS) {
    const value = env[key];
    values[key] = value === undefined
      ? { present: false }
      : { present: true, value };
  }

  return {
    keys: [...CONSUMED_ENV_KEYS],
    values,
  };
}
