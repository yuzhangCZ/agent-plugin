import { homedir } from "node:os";
import { join } from "node:path";
import type { RegistryConfigAdapter } from "../domain/ports.ts";
import { readOptionalTextFile, writeFileAtomically } from "../infrastructure/fs-utils.ts";
import { InstallCliError } from "../domain/errors.ts";

const SCOPE_REGISTRY_PREFIX = "@wecode:registry=";
const DEFAULT_REGISTRY = "https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/";

function resolveUserNpmrcPath(env = process.env, platform = process.platform) {
  if (env.NPM_CONFIG_USERCONFIG?.trim()) {
    return env.NPM_CONFIG_USERCONFIG.trim();
  }
  if (platform === "win32") {
    return join(env.USERPROFILE || homedir(), ".npmrc");
  }
  return join(env.HOME || homedir(), ".npmrc");
}

function normalizeRegistry(registry: string) {
  return registry.endsWith("/") ? registry : `${registry}/`;
}

function readScopedRegistry(content: string | null) {
  if (!content) {
    return "";
  }
  const match = content.match(/^\s*@wecode:registry=(.+?)\s*$/m);
  return match?.[1]?.trim() ?? "";
}

export class NpmrcRegistryConfigAdapter implements RegistryConfigAdapter {
  private readonly npmrcPath: string;
  private readonly envRegistry: string;

  constructor(npmrcPath = resolveUserNpmrcPath(), envRegistry = process.env.WECODE_NPM_REGISTRY?.trim() || "") {
    this.npmrcPath = npmrcPath;
    this.envRegistry = envRegistry;
  }

  async resolveRegistry(preferredRegistry?: string) {
    const cliRegistry = String(preferredRegistry ?? "").trim();
    if (cliRegistry) {
      return normalizeRegistry(cliRegistry);
    }
    if (this.envRegistry) {
      return normalizeRegistry(this.envRegistry);
    }
    const existing = await readOptionalTextFile(this.npmrcPath);
    const existingRegistry = readScopedRegistry(existing);
    return normalizeRegistry(existingRegistry || DEFAULT_REGISTRY);
  }

  async ensureRegistry(registry: string) {
    const normalized = normalizeRegistry(String(registry ?? "").trim());
    if (!normalized) {
      throw new InstallCliError("REGISTRY_NOT_CONFIGURED", "缺少 @wecode registry。");
    }

    const existing = await readOptionalTextFile(this.npmrcPath);
    const lines = (existing ?? "").split(/\r?\n/);
    let replaced = false;
    const nextLines = lines.map((line) => {
      if (!line.trim().startsWith(SCOPE_REGISTRY_PREFIX)) {
        return line;
      }
      replaced = true;
      return `${SCOPE_REGISTRY_PREFIX}${normalized}`;
    });
    const nextContent = replaced
      ? `${nextLines.join("\n").replace(/\s*$/u, "")}\n`
      : `${(existing ?? "").replace(/\s*$/u, "")}${existing && existing.trim() ? "\n" : ""}${SCOPE_REGISTRY_PREFIX}${normalized}\n`;

    if (nextContent !== existing) {
      await writeFileAtomically(this.npmrcPath, nextContent);
    }

    return {
      path: this.npmrcPath,
      changed: nextContent !== existing,
    };
  }
}
