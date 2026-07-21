const SDK_PACKAGE_NAME = '@wecode/bridge-runtime-sdk';

interface NodeFsModule {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

interface NodeProcessWithBuiltinModule {
  getBuiltinModule?: (name: string) => unknown;
}

let cachedSourcePackageVersion: string | null | undefined;

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

function getNodeFsModule(): NodeFsModule | null {
  const nodeProcess = (globalThis as typeof globalThis & { process?: NodeProcessWithBuiltinModule }).process;
  const candidate = nodeProcess?.getBuiltinModule?.('node:fs');
  if (!isRecord(candidate) || typeof candidate.readFileSync !== 'function') {
    return null;
  }

  return candidate as unknown as NodeFsModule;
}

function readSourcePackageVersion(): string | null {
  if (cachedSourcePackageVersion !== undefined) {
    return cachedSourcePackageVersion;
  }

  try {
    const fs = getNodeFsModule();
    if (!fs) {
      cachedSourcePackageVersion = null;
      return cachedSourcePackageVersion;
    }

    const sourcePackageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (!isRecord(sourcePackageJson) || sourcePackageJson.name !== SDK_PACKAGE_NAME) {
      cachedSourcePackageVersion = null;
      return cachedSourcePackageVersion;
    }

    const candidate = sourcePackageJson.version;
    if (typeof candidate !== 'string') {
      cachedSourcePackageVersion = null;
      return cachedSourcePackageVersion;
    }

    const normalized = candidate.trim();
    cachedSourcePackageVersion = normalized || null;
    return cachedSourcePackageVersion;
  } catch {
    cachedSourcePackageVersion = null;
    return cachedSourcePackageVersion;
  }
}

/**
 * 读取 bridge-runtime-sdk 分发包在构建期注入的版本号。
 */
export function resolvePackageVersion(): string | undefined {
  return readInjectedPackageVersion() ?? readSourcePackageVersion() ?? undefined;
}
