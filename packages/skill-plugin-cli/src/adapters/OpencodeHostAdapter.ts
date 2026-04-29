import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HostAdapter, ProcessRunner } from "../domain/ports.ts";
import type { HostAvailabilityResult, HostConfigureResult, HostMetadata, InstallContext } from "../domain/types.ts";
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
  private readonly env: NodeJS.ProcessEnv;

  constructor(processRunner: ProcessRunner, env = process.env) {
    this.processRunner = processRunner;
    this.env = env;
  }

  resolveDefaultUrl() {
    const candidate = (globalThis as typeof globalThis & { __MB_DEFAULT_GATEWAY_URL__?: unknown }).__MB_DEFAULT_GATEWAY_URL__;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : DEFAULT_GATEWAY_URL;
  }

  private async resolvePaths() {
    const configDir = resolveGlobalConfigDir(this.env);
    return {
      configDir: resolve(configDir),
      bridgeConfig: await resolvePreferredExistingPath(join(configDir, "message-bridge.jsonc"), join(configDir, "message-bridge.json")),
      opencodeConfig: await resolvePreferredExistingPath(join(configDir, "opencode.jsonc"), join(configDir, "opencode.json")),
    };
  }

  private buildMetadata(primaryConfigPath: string): HostMetadata {
    return {
      host: "opencode",
      hostDisplayName: "opencode",
      packageName: PLUGIN_NAME,
      primaryConfigPath,
    };
  }

  async preflight() {
    const version = await this.processRunner.exec("opencode", ["--version"]);
    if (version.exitCode !== 0) {
      throw new InstallCliError("OPENCODE_NOT_FOUND", (version.stderr || version.stdout || "未检测到 opencode 命令。").trim());
    }

    const paths = await this.resolvePaths();
    return {
      metadata: this.buildMetadata(paths.opencodeConfig),
    };
  }

  async installPlugin() {
    const result = await this.processRunner.spawn("opencode", ["plugin", "-g", "-f", PLUGIN_NAME]);
    if (result.exitCode !== 0) {
      throw new InstallCliError("PLUGIN_INSTALL_FAILED", `opencode plugin -g -f ${PLUGIN_NAME} 失败，退出码 ${result.exitCode}`);
    }
  }

  async verifyPlugin() {
    const paths = await this.resolvePaths();
    const content = await readOptionalTextFile(paths.opencodeConfig);
    if (content !== null && content.includes(PLUGIN_NAME)) {
      return;
    }
    throw new InstallCliError("PLUGIN_INSTALL_VERIFICATION_FAILED", `未在 ${paths.opencodeConfig} 中确认到插件 ${PLUGIN_NAME}`);
  }

  async configureHost(context: InstallContext, credentials: { ak: string; sk: string }): Promise<HostConfigureResult> {
    const paths = await this.resolvePaths();
    const existingBridge = await readOptionalTextFile(paths.bridgeConfig);
    const existingOpencode = await readOptionalTextFile(paths.opencodeConfig);
    let nextBridge: string;
    let nextOpencode: string;
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
      nextOpencode = buildNextOpencodeConfig(existingOpencode, PLUGIN_NAME);
    } catch (error) {
      throw new InstallCliError("HOST_CONFIGURE_FAILED", error instanceof Error ? error.message : String(error));
    }
    await writeFileAtomically(paths.bridgeConfig, nextBridge);
    await writeFileAtomically(paths.opencodeConfig, nextOpencode);
    return {
      primaryConfigPath: paths.opencodeConfig,
      additionalConfigPaths: [paths.bridgeConfig],
    };
  }

  async confirmAvailability(_context: InstallContext): Promise<HostAvailabilityResult> {
    const status = await this.processRunner.exec("opencode", ["--version"]);
    if (status.exitCode !== 0) {
      throw new InstallCliError("HOST_AVAILABILITY_FAILED", "OpenCode 进程探测失败。");
    }
    return {
      nextAction: {
        kind: "restart_host",
        manual: true,
        effect: "plugin_and_config_effective",
      },
    };
  }
}
