import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { HostAdapter, PluginArtifactPort, ProcessRunner } from "../domain/ports.ts";
import type { HostAvailabilityResult, HostConfigureResult, InstallContext, InstalledPluginArtifact } from "../domain/types.ts";
import { InstallCliError } from "../domain/errors.ts";
import { buildNextBridgeConfig, buildNextBridgeConfigWithoutUrl, buildNextOpencodeConfig } from "./config-editors.ts";
import { readOptionalTextFile, writeFileAtomically } from "../infrastructure/fs-utils.ts";

const PLUGIN_NAME = "@wecode/skill-opencode-plugin";
const DEFAULT_GATEWAY_URL = "ws://localhost:8081/ws/agent";

function resolveGlobalConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR?.trim()) {
    return env.OPENCODE_CONFIG_DIR.trim();
  }
  if (env.XDG_CONFIG_HOME?.trim()) {
    return join(env.XDG_CONFIG_HOME.trim(), "opencode");
  }
  if (process.platform === "win32") {
    return join(env.USERPROFILE || homedir(), ".config", "opencode");
  }
  return join(env.HOME || homedir(), ".config", "opencode");
}

async function resolvePreferredExistingPath(jsoncPath: string, jsonPath: string) {
  const jsoncContent = await readOptionalTextFile(jsoncPath);
  return jsoncContent !== null ? jsoncPath : jsonPath;
}

export class OpencodeHostAdapter implements HostAdapter {
  readonly host = "opencode" as const;
  readonly packageName = PLUGIN_NAME;
  private readonly processRunner: ProcessRunner;
  private readonly pluginArtifactPort: PluginArtifactPort;
  private readonly env: NodeJS.ProcessEnv;

  constructor(processRunner: ProcessRunner, pluginArtifactPort: PluginArtifactPort, env = process.env) {
    this.processRunner = processRunner;
    this.pluginArtifactPort = pluginArtifactPort;
    this.env = env;
  }

  resolveDefaultUrl() {
    const candidate = (globalThis as typeof globalThis & { __MB_DEFAULT_GATEWAY_URL__?: unknown }).__MB_DEFAULT_GATEWAY_URL__;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : DEFAULT_GATEWAY_URL;
  }

  private async resolvePaths() {
    const configDir = resolveGlobalConfigDir(this.env);
    return {
      configDir,
      bridgeConfig: await resolvePreferredExistingPath(join(configDir, "message-bridge.jsonc"), join(configDir, "message-bridge.json")),
      opencodeConfig: await resolvePreferredExistingPath(join(configDir, "opencode.jsonc"), join(configDir, "opencode.json")),
      legacyPluginEntry: join(configDir, "plugins", "message-bridge.js"),
    };
  }

  private resolveControlledFallbackRoot() {
    const cacheRoot = this.env.XDG_CACHE_HOME?.trim()
      ? join(this.env.XDG_CACHE_HOME.trim(), "skill-plugin-cli")
      : join(this.env.HOME || homedir(), ".cache", "skill-plugin-cli");
    return normalize(resolve(cacheRoot, "opencode", "extracted", PLUGIN_NAME));
  }

  private isControlledFallbackPathSpec(value: string) {
    const normalizedSpec = normalize(resolve(value));
    const controlledRoot = this.resolveControlledFallbackRoot();
    return normalizedSpec === controlledRoot || normalizedSpec.startsWith(`${controlledRoot}${process.platform === "win32" ? "\\" : "/"}`);
  }

  private async reconcilePluginReference(pluginSpec: string) {
    const paths = await this.resolvePaths();
    const existingOpencode = await readOptionalTextFile(paths.opencodeConfig);
    const nextOpencode = buildNextOpencodeConfig(existingOpencode, pluginSpec, {
      controlledNpmSpec: PLUGIN_NAME,
      isControlledFallbackPathSpec: (value) => this.isControlledFallbackPathSpec(value),
    });
    await writeFileAtomically(paths.opencodeConfig, nextOpencode);
  }

  async preflight() {
    const version = await this.processRunner.exec("opencode", ["--version"]);
    if (version.exitCode !== 0) {
      throw new InstallCliError("OPENCODE_NOT_FOUND", (version.stderr || version.stdout || "未检测到 opencode 命令。").trim());
    }

    const paths = await this.resolvePaths();
    return {
      hostLabel: "OpenCode",
      detail: `opencode 可用，配置路径 ${paths.opencodeConfig}`,
    };
  }

  async installPlugin(context: InstallContext, _presenter: { info(message: string): void }): Promise<InstalledPluginArtifact> {
    if (context.installStrategy === "host-native") {
      const result = await this.processRunner.spawn("opencode", ["plugin", "-g", "-f", PLUGIN_NAME], { stdio: "inherit" });
      if (result.exitCode !== 0) {
        throw new InstallCliError("PLUGIN_INSTALL_FAILED", `opencode plugin -g -f ${PLUGIN_NAME} 失败，退出码 ${result.exitCode}`);
      }
      const artifact = {
        installStrategy: "host-native" as const,
        pluginSpec: PLUGIN_NAME,
        packageName: PLUGIN_NAME,
      };
      await this.reconcilePluginReference(artifact.pluginSpec);
      return artifact;
    }
    const artifact = await this.pluginArtifactPort.fetchArtifact({
      host: this.host,
      installStrategy: context.installStrategy,
      packageName: PLUGIN_NAME,
      registry: context.registry,
    });
    await this.reconcilePluginReference(artifact.pluginSpec);
    return artifact;
  }

  async cleanupLegacyArtifacts() {
    const paths = await this.resolvePaths();
    try {
      await rm(paths.legacyPluginEntry);
      return { warnings: [] };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "ENOENT") {
          return { warnings: [] };
        }
        return { warnings: [`OpenCode 历史残留文件清理失败，请手动删除：${paths.legacyPluginEntry}`] };
      }
      throw error;
    }
  }

  async verifyPlugin(_context: InstallContext, artifact: InstalledPluginArtifact) {
    const paths = await this.resolvePaths();
    const content = await readOptionalTextFile(paths.opencodeConfig);
    if (content !== null && content.includes(`"${artifact.pluginSpec}"`)) {
      return;
    }
    throw new InstallCliError("PLUGIN_INSTALL_VERIFICATION_FAILED", `未在 ${paths.opencodeConfig} 中确认到插件 ${artifact.pluginSpec}`);
  }

  async configureHost(context: InstallContext, credentials: { ak: string; sk: string }): Promise<HostConfigureResult> {
    const paths = await this.resolvePaths();
    const existingBridge = await readOptionalTextFile(paths.bridgeConfig);
    let nextBridge: string;
    try {
      nextBridge = context.url
        ? buildNextBridgeConfig(existingBridge, {
            ak: credentials.ak,
            sk: credentials.sk,
            url: context.url,
          })
        : buildNextBridgeConfigWithoutUrl(existingBridge, {
            ak: credentials.ak,
            sk: credentials.sk,
          });
    } catch (error) {
      throw new InstallCliError("HOST_CONFIGURE_FAILED", error instanceof Error ? error.message : String(error));
    }
    await writeFileAtomically(paths.bridgeConfig, nextBridge);
    return {
      detail: `已写入 ${paths.bridgeConfig}`,
    };
  }

  async confirmAvailability(_context: InstallContext): Promise<HostAvailabilityResult> {
    const status = await this.processRunner.exec("opencode", ["--version"]);
    if (status.exitCode !== 0) {
      throw new InstallCliError("HOST_AVAILABILITY_FAILED", "OpenCode 进程探测失败。");
    }
    return {
      detail: "已完成 OpenCode 可执行性确认。",
      nextSteps: [
        "下一步：请手动重启 OpenCode 以确认插件与配置生效。",
        "可执行命令：opencode",
      ],
    };
  }
}
