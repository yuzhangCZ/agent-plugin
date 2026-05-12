const UNKNOWN_PACKAGE_VERSION = 'unknown';

function readInjectedPackageVersion(): string | null {
  const candidate = (globalThis as typeof globalThis & { __MB_PACKAGE_VERSION__?: unknown }).__MB_PACKAGE_VERSION__;
  if (typeof candidate !== 'string') {
    return null;
  }

  const normalized = candidate.trim();
  return normalized || null;
}

/**
 * 读取 bridge-runtime-sdk 分发包在构建期注入的版本号。
 */
export function resolvePackageVersion(): string {
  return readInjectedPackageVersion() ?? UNKNOWN_PACKAGE_VERSION;
}
