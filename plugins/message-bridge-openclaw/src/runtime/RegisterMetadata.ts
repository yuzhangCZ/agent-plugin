import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_TOOL_TYPES, isKnownToolType } from "../contracts/transport.js";
import type { BridgeLogger } from "../types.js";

export const MESSAGE_BRIDGE_TOOL_TYPE = "openx";

export interface RegisterMetadata {
  toolType: string;
  toolVersion: string;
}

export interface RegisterMetadataDeps {
  toolVersion?: string;
}

const UNKNOWN_TOOL_VERSION = "unknown";

/**
 * 解析注册元数据中的 toolVersion。
 * @remarks 这里表达的是宿主 agent 版本，不是插件包版本；因此不读取构建期注入的 package version。
 */
function resolveHostToolVersion(logger: BridgeLogger): string {
  const moduleFile = fileURLToPath(import.meta.url);
  let currentDir = path.dirname(moduleFile);

  for (let depth = 0; depth < 6; depth += 1) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
        if (typeof packageJson.version === "string" && packageJson.version.trim()) {
          return packageJson.version.trim();
        }
      } catch (error) {
        logger.warn("runtime.tool_version.read_failed", {
          packageJsonPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  logger.warn("runtime.tool_version.unavailable");
  return UNKNOWN_TOOL_VERSION;
}

export function resolveRegisterMetadata(
  logger: BridgeLogger,
  deps: RegisterMetadataDeps = {},
): RegisterMetadata {
  return {
    toolType: MESSAGE_BRIDGE_TOOL_TYPE,
    toolVersion: deps.toolVersion?.trim() || resolveHostToolVersion(logger),
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
