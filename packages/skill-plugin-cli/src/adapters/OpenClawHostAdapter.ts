import type { HostAdapter, PluginArtifactPort, ProcessRunner } from "../domain/ports.ts";
import type { HostAvailabilityResult, HostConfigureResult, InstallContext, InstalledPluginArtifact } from "../domain/types.ts";
import { InstallCliError } from "../domain/errors.ts";

const PACKAGE_NAME = "@wecode/skill-openclaw-plugin";
const PLUGIN_ID = "skill-openclaw-plugin";
const CHANNEL_ID = "message-bridge";
const DEFAULT_GATEWAY_URL = "ws://localhost:8081/ws/agent";
const MIN_SUPPORTED_VERSION = "2026.3.24";

function parseVersion(text: string) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(a: number[], b: number[]) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function assertVersionRange(versionText: string) {
  const parsed = parseVersion(versionText);
  if (!parsed) {
    throw new InstallCliError("OPENCLAW_VERSION_UNSUPPORTED", `无法识别 OpenClaw 版本：${versionText}`);
  }
  const lower = parseVersion(MIN_SUPPORTED_VERSION);
  if (!lower || compareVersion(parsed, lower) < 0) {
    throw new InstallCliError("OPENCLAW_VERSION_UNSUPPORTED", `当前 OpenClaw 版本 ${versionText} 不满足 >=${MIN_SUPPORTED_VERSION}`);
  }
}

export class OpenClawHostAdapter implements HostAdapter {
  readonly host = "openclaw" as const;
  readonly packageName = PACKAGE_NAME;
  private readonly processRunner: ProcessRunner;
  private readonly pluginArtifactPort: PluginArtifactPort;

  constructor(processRunner: ProcessRunner, pluginArtifactPort: PluginArtifactPort) {
    this.processRunner = processRunner;
    this.pluginArtifactPort = pluginArtifactPort;
  }

  resolveDefaultUrl() {
    const candidate = (globalThis as typeof globalThis & { __MB_DEFAULT_GATEWAY_URL__?: unknown }).__MB_DEFAULT_GATEWAY_URL__;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : DEFAULT_GATEWAY_URL;
  }

  /**
   * 统一执行 OpenClaw 插件信息探测，安装前与安装后都仅依赖退出码。
   */
  private async queryInstalledPlugin() {
    return this.processRunner.exec("openclaw", ["plugins", "info", PLUGIN_ID, "--json"]);
  }

  async preflight() {
    const result = await this.processRunner.exec("openclaw", ["--version"]);
    if (result.exitCode !== 0) {
      throw new InstallCliError("OPENCLAW_NOT_FOUND", (result.stderr || result.stdout || "未检测到 openclaw 命令。").trim());
    }
    const version = (result.stdout || result.stderr).trim();
    assertVersionRange(version);
    return {
      hostLabel: "OpenClaw",
      detail: `openclaw 可用，版本 ${version}`,
    };
  }

  async installPlugin(context: InstallContext, presenter: { info(message: string): void }): Promise<InstalledPluginArtifact> {
    const probe = await this.queryInstalledPlugin();
    if (probe.exitCode === 0) {
      presenter.info("检测到已安装 OpenClaw 插件，正在卸载后重装。");
      const uninstall = await this.processRunner.spawn("openclaw", ["plugins", "uninstall", PLUGIN_ID, "--force"], { stdio: "inherit" });
      if (uninstall.exitCode !== 0) {
        throw new InstallCliError("PLUGIN_INSTALL_FAILED", `openclaw plugins uninstall ${PLUGIN_ID} --force 失败，退出码 ${uninstall.exitCode}`);
      }
    }
    if (context.installStrategy === "fallback") {
      const artifact = await this.pluginArtifactPort.fetchArtifact({
        host: this.host,
        installStrategy: context.installStrategy,
        packageName: PACKAGE_NAME,
        registry: context.registry,
      });
      const result = await this.processRunner.spawn("openclaw", ["plugins", "install", artifact.localTarballPath!], { stdio: "inherit" });
      if (result.exitCode !== 0) {
        throw new InstallCliError("PLUGIN_INSTALL_FAILED", `openclaw plugins install ${artifact.localTarballPath} 失败，退出码 ${result.exitCode}`);
      }
      return artifact;
    }
    const result = await this.processRunner.spawn("openclaw", ["plugins", "install", PACKAGE_NAME], { stdio: "inherit" });
    if (result.exitCode !== 0) {
      throw new InstallCliError("PLUGIN_INSTALL_FAILED", `openclaw plugins install ${PACKAGE_NAME} 失败，退出码 ${result.exitCode}`);
    }
    return {
      installStrategy: "host-native",
      pluginSpec: PACKAGE_NAME,
      packageName: PACKAGE_NAME,
    };
  }

  async cleanupLegacyArtifacts() {
    return { warnings: [] };
  }

  async verifyPlugin() {
    const result = await this.queryInstalledPlugin();
    if (result.exitCode !== 0) {
      throw new InstallCliError("PLUGIN_INSTALL_VERIFICATION_FAILED", (result.stderr || result.stdout).trim());
    }
  }

  async configureHost(context: InstallContext, credentials: { ak: string; sk: string }): Promise<HostConfigureResult> {
    const args = [
      "channels",
      "add",
      "--channel",
      CHANNEL_ID,
    ];
    if (context.url) {
      args.push("--url", context.url);
    }
    args.push(
      "--token",
      credentials.ak,
      "--password",
      credentials.sk,
    );
    const result = await this.processRunner.spawn(
      "openclaw",
      args,
      { stdio: "inherit" },
    );
    if (result.exitCode !== 0) {
      throw new InstallCliError("HOST_CONFIGURE_FAILED", `openclaw channels add 失败，退出码 ${result.exitCode}`);
    }
    return {
      detail: "已完成 Message Bridge channel 接入。",
    };
  }

  async confirmAvailability(): Promise<HostAvailabilityResult> {
    const status = await this.processRunner.exec("openclaw", ["--version"]);
    if (status.exitCode !== 0) {
      throw new InstallCliError("HOST_AVAILABILITY_FAILED", "OpenClaw 进程探测失败。");
    }
    return {
      detail: "已完成 OpenClaw 可执行性确认。",
      nextSteps: [
        "下一步：请手动重启 OpenClaw gateway，并通过实际消息链路确认 channel 生效。",
        "可执行命令：openclaw gateway restart",
      ],
    };
  }
}
