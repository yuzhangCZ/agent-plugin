import { readFileSync } from 'node:fs';

const SDK_PACKAGE_NAME = '@wecode/bridge-runtime-sdk';

function readInjectedPackageVersion(): string | null {
  const candidate = (globalThis as typeof globalThis & { __MB_SDK_PACKAGE_VERSION__?: unknown }).__MB_SDK_PACKAGE_VERSION__;
  if (typeof candidate !== 'string') {
    return null;
  }

  const normalized = candidate.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readSourcePackageVersion(): string | null {
  try {
    const sourcePackageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (!isRecord(sourcePackageJson) || sourcePackageJson.name !== SDK_PACKAGE_NAME) {
      return null;
    }

    const candidate = sourcePackageJson.version;
    if (typeof candidate !== 'string') {
      return null;
    }

    const normalized = candidate.trim();
    return normalized || null;
  } catch {
    return null;
  }
}

/**
 * 读取 bridge-runtime-sdk 分发包在构建期注入的版本号。
 */
export function resolvePackageVersion(): string | undefined {
  return readInjectedPackageVersion() ?? readSourcePackageVersion() ?? undefined;
}
