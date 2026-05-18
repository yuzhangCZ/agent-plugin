import { spawnSync } from "node:child_process";
import { KNOWN_TOOL_TYPES, isKnownToolType } from "../contracts/transport.js";
import { resolvePackageVersion } from "./packageVersion.js";
import type { BridgeLogger } from "../types.js";

export const MESSAGE_BRIDGE_TOOL_TYPE = "openclaw";

export interface RegisterMetadata {
  toolType: string;
  toolVersion: string;
  pluginVersion: string;
}

export interface RegisterMetadataDeps {
  toolVersion?: string;
  resolveHostToolVersion?: (logger: BridgeLogger) => string;
  resolveClientVersion?: () => string;
}

const UNKNOWN_TOOL_VERSION = "unknown";
let cachedHostToolVersion: string | null = null;

/**
 * 解析注册元数据中的 toolVersion。
 * @remarks 这里表达的是宿主 OpenClaw 版本，不是插件包版本；因此优先取 `openclaw --version`。
 */
function resolveHostToolVersion(logger: BridgeLogger): string {
  if (cachedHostToolVersion !== null) {
    return cachedHostToolVersion;
  }

  const result = spawnSync("openclaw --version", {
    shell: true,
    encoding: "utf8",
  });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (!result.error && result.status === 0 && combinedOutput) {
    cachedHostToolVersion = combinedOutput;
    return cachedHostToolVersion;
  }

  logger.warn("runtime.tool_version.unavailable", {
    exitCode: result.status,
    error: result.error instanceof Error ? result.error.message : undefined,
    stderr: stderr || undefined,
  });
  cachedHostToolVersion = UNKNOWN_TOOL_VERSION;
  return cachedHostToolVersion;
}

export function resolveRegisterMetadata(
  logger: BridgeLogger,
  deps: RegisterMetadataDeps = {},
): RegisterMetadata {
  const resolvedHostToolVersion = deps.toolVersion?.trim()
    || (deps.resolveHostToolVersion ?? resolveHostToolVersion)(logger).trim()
    || UNKNOWN_TOOL_VERSION;

  return {
    toolType: MESSAGE_BRIDGE_TOOL_TYPE,
    toolVersion: resolvedHostToolVersion,
    pluginVersion: (deps.resolveClientVersion ?? resolvePackageVersion)(),
  };
}

export function warnUnknownToolType(logger: BridgeLogger, toolType: string, accountId?: string): void {
  if (isKnownToolType(toolType)) {
    return;
  }

  logger.warn("runtime.register.tool_type.unknown", {
    toolType,
    knownToolTypes: [...KNOWN_TOOL_TYPES],
    ...(accountId ? { accountId } : {}),
  });
}
