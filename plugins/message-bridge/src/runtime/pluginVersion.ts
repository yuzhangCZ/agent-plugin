const UNKNOWN_PLUGIN_VERSION = 'unknown';

function readInjectedPluginVersion(): string | null {
  const candidate = (globalThis as typeof globalThis & { __MB_PLUGIN_VERSION__?: unknown }).__MB_PLUGIN_VERSION__;
  if (typeof candidate !== 'string') {
    return null;
  }

  const normalized = candidate.trim();
  return normalized || null;
}

export function resolvePluginVersion(): string {
  return readInjectedPluginVersion() ?? UNKNOWN_PLUGIN_VERSION;
}
