import process from "node:process";
import qrcodeTerminal from "qrcode-terminal";
import supportsHyperlinks from "supports-hyperlinks";
import type { Presenter } from "../domain/ports.ts";
import { INSTALL_STAGE_LABELS } from "../domain/stages.ts";
import type { CliQrFailureSummary, CliQrSnapshot, HostAvailabilityResult, InstalledPluginArtifact, PresenterFailure } from "../domain/types.ts";

const SENSITIVE_SNAPSHOT_EXACT_FIELDS = new Set(["ak", "sk"]);

function writeStdout(message = "") {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string) {
  process.stderr.write(`${message}\n`);
}

function renderQrCode(data: string) {
  let rendered = "";
  qrcodeTerminal.generate(data, { small: true }, (qrcode) => {
    rendered = qrcode.replace(/\s*$/u, "");
  });
  return rendered;
}

function isClassicWindowsConsole(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "win32") {
    return false;
  }

  // 经典 cmd.exe / powershell.exe 保持纯 URL，避免输出不可见控制序列。
  return !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuPID;
}

function probeHyperlinkSupport(env = process.env, platform = process.platform) {
  if (isClassicWindowsConsole(env, platform)) {
    return false;
  }

  const stdoutProbe = supportsHyperlinks.stdout;
  if (typeof stdoutProbe === "boolean") {
    return stdoutProbe;
  }
  if (typeof stdoutProbe === "function") {
    return stdoutProbe(process.stdout);
  }
  return typeof supportsHyperlinks === "function" ? supportsHyperlinks(process.stdout) : false;
}

function formatTerminalHyperlink(url: string) {
  return `\u001B]8;;${url}\u001B\\${url}\u001B]8;;\u001B\\`;
}

function formatUtcTimestamp(value: string) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

function formatStageLabel(input: {
  host: "opencode" | "openclaw";
  stage: keyof typeof INSTALL_STAGE_LABELS;
  packageName?: string;
}) {
  const { host, stage, packageName } = input;
  const base = INSTALL_STAGE_LABELS[stage];
  switch (stage) {
    case "check_host_environment":
      return `检查 ${host} 环境`;
    case "install_plugin":
      return packageName ? `安装插件 ${packageName}` : "安装插件";
    case "write_host_configuration":
      return `写入 ${host} 连接配置`;
    default:
      return base;
  }
}

function formatAvailabilityNextSteps(host: "opencode" | "openclaw", availability: HostAvailabilityResult) {
  if (availability.nextAction.kind === "restart_gateway") {
    return [
      "下一步：请手动重启 openclaw gateway 以使新配置生效",
      availability.nextAction.command ? `可执行命令：${availability.nextAction.command}` : undefined,
    ].filter(Boolean) as string[];
  }
  return [`下一步：请重启 ${host} 以使插件与配置生效`];
}

function formatQrFailureSummary(summary: CliQrFailureSummary) {
  if (summary.type === "network_error") {
    const parts = ["network_error"];
    if (summary.code) {
      parts.push(`code=${summary.code}`);
    }
    if (summary.message) {
      parts.push(`message=${summary.message}`);
    }
    return parts.join(", ");
  }

  const parts: string[] = [];
  if (summary.businessCode) {
    parts.push(`businessCode=${summary.businessCode}`);
  }
  if (summary.error) {
    parts.push(`error=${summary.error}`);
  }
  if (summary.message) {
    parts.push(`message=${summary.message}`);
  }
  if (typeof summary.httpStatus === "number") {
    parts.push(`httpStatus=${summary.httpStatus}`);
  }
  return parts.length > 0 ? parts.join(", ") : "auth_service_error";
}

function formatArtifactSummary(artifact: InstalledPluginArtifact) {
  return `[skill-plugin-cli] fallback 产物已解析：package=${artifact.packageName}`
    + `${artifact.packageVersion ? ` version=${artifact.packageVersion}` : ""}`
    + `${artifact.localTarballPath ? ` tarball=${artifact.localTarballPath}` : ""}`;
}

function normalizeSnapshotFieldName(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveSnapshotField(key: string) {
  const normalized = normalizeSnapshotFieldName(key);
  return SENSITIVE_SNAPSHOT_EXACT_FIELDS.has(normalized) || normalized.includes("token");
}

function redactSnapshotValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveSnapshotField(key)) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSnapshotValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactSnapshotValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function formatRedactedSnapshot(snapshot: unknown) {
  try {
    return JSON.stringify(redactSnapshotValue(snapshot));
  } catch {
    return "<unserializable>";
  }
}

/**
 * 统一收口 CLI 终端输出，确保默认 transcript、verbose 诊断和二维码展示 contract 保持稳定。
 */
export class TerminalCliPresenter implements Presenter {
  private readonly qrCodeRenderer: (data: string) => string;
  private readonly shouldRenderHyperlink: () => boolean;

  constructor(
    qrCodeRenderer: (data: string) => string = renderQrCode,
    shouldRenderHyperlink: () => boolean = probeHyperlinkSupport,
  ) {
    this.qrCodeRenderer = qrCodeRenderer;
    this.shouldRenderHyperlink = shouldRenderHyperlink;
  }

  installStarted(input: { host: "opencode" | "openclaw"; packageName: string }) {
    writeStdout(`[skill-plugin-cli] 正在为 ${input.host} 安装 ${input.packageName}，请稍候`);
  }

  hostVersionResolved(input: { host: "opencode" | "openclaw"; version: string }) {
    if (input.host !== "openclaw") {
      return;
    }
    writeStdout(`[skill-plugin-cli] openclaw 版本：${input.version}`);
  }

  hostConfigPathResolved(input: { host: "opencode" | "openclaw"; primaryConfigPath: string }) {
    writeStdout(`[skill-plugin-cli] ${input.host} 配置路径: ${input.primaryConfigPath}`);
  }

  reinstallDetected() {
    writeStdout("[skill-plugin-cli] 检测到已安装插件，将执行重装");
  }

  stageProgress(input: {
    host: "opencode" | "openclaw";
    stage: keyof typeof INSTALL_STAGE_LABELS;
    status: "started" | "succeeded" | "failed";
    packageName?: string;
    verboseDetail?: string;
  }) {
    const label = formatStageLabel(input);
    if (input.status === "started") {
      writeStdout(`[skill-plugin-cli][${input.host}] 开始：${label}`);
      return;
    }
    if (input.status === "succeeded") {
      writeStdout(`[skill-plugin-cli] 完成：${label}${input.verboseDetail ? ` · ${input.verboseDetail}` : ""}`);
      return;
    }
    writeStderr(`[skill-plugin-cli] 失败：${label}${input.verboseDetail ? ` · ${input.verboseDetail}` : ""}`);
  }

  installStrategyResolved(input: { strategy: "host-native" | "fallback" }) {
    writeStdout(`[skill-plugin-cli] 安装策略：${input.strategy}`);
  }

  fallbackArtifactResolved(input: { artifact: InstalledPluginArtifact }) {
    writeStdout(formatArtifactSummary(input.artifact));
  }

  fallbackApplied(input: { artifact: InstalledPluginArtifact }) {
    writeStdout(`[skill-plugin-cli] fallback 已写入宿主目标：pluginSpec=${input.artifact.pluginSpec}`);
  }

  warningRaised(input: { message: string }) {
    writeStdout(`[skill-plugin-cli][warning] ${input.message}`);
  }

  commandBoundary(input: { phase: "started" | "finished"; command: string; stdout?: string; stderr?: string; exitCode?: number }) {
    if (input.phase === "started") {
      writeStdout(`[skill-plugin-cli] 正在执行命令：${input.command}`);
      return;
    }
    if (input.stdout) {
      process.stdout.write(input.stdout);
      if (!input.stdout.endsWith("\n")) {
        writeStdout();
      }
    }
    if (input.stderr) {
      process.stderr.write(input.stderr);
      if (!input.stderr.endsWith("\n")) {
        writeStderr("");
      }
    }
    writeStdout(`[skill-plugin-cli] 命令执行结束：${input.command}`);
  }

  pluginInstalled() {
    writeStdout("[skill-plugin-cli] 插件安装完成");
  }

  qrSnapshot(snapshot: CliQrSnapshot) {
    switch (snapshot.type) {
      case "qrcode_generated": {
        if (snapshot.refresh) {
          writeStdout(`[skill-plugin-cli] ========= 已刷新二维码（第 ${snapshot.refresh.index}/${snapshot.refresh.max} 次） =========`);
          writeStdout();
        } else {
          writeStdout("[skill-plugin-cli] 请使用 WeLink 扫码创建助理");
        }
        try {
          writeStdout(this.qrCodeRenderer(snapshot.weUrl));
        } catch {
          writeStdout(`[skill-plugin-cli] weUrl: ${snapshot.weUrl}`);
        }
        writeStdout(
          `[skill-plugin-cli] pc WeLink 创建助理地址: ${
            this.shouldRenderHyperlink() ? formatTerminalHyperlink(snapshot.pcUrl) : snapshot.pcUrl
          }`,
        );
        writeStdout(`[skill-plugin-cli] 二维码有效期至: ${formatUtcTimestamp(snapshot.expiresAt)}`);
        writeStdout("[skill-plugin-cli] 请在 WeLink 中创建助理");
        return;
      }
      case "expired":
        writeStdout("[skill-plugin-cli] 二维码已过期，正在刷新");
        writeStdout();
        return;
      case "confirmed":
        writeStdout("[skill-plugin-cli] 二维码状态：已确认");
        return;
      case "cancelled":
        writeStdout("[skill-plugin-cli] 二维码状态：已取消");
        return;
      case "scanned":
        writeStdout("[skill-plugin-cli] 二维码状态：已扫码，请在 WeLink 中创建助理");
        return;
      case "failed":
        return;
    }
  }

  qrSnapshotDiagnostic(snapshot: unknown) {
    writeStdout(`[skill-plugin-cli][verbose] qrcode snapshot: ${formatRedactedSnapshot(snapshot)}`);
  }

  assistantCreated(input: { host: "opencode" | "openclaw"; primaryConfigPath: string; additionalConfigPaths: string[] }) {
    writeStdout(`[skill-plugin-cli] 助理创建完成，正在写入 ${input.host} 连接配置`);
  }

  availabilityChecked() {
    writeStdout("[skill-plugin-cli] 已完成连接可用性检查");
  }

  completed(input: { host: "opencode" | "openclaw"; availability: HostAvailabilityResult }) {
    writeStdout(`[skill-plugin-cli] 接入完成：${input.host} 已完成插件安装、助理创建与 gateway 配置`);
    for (const line of formatAvailabilityNextSteps(input.host, input.availability)) {
      writeStdout(`[skill-plugin-cli] ${line}`);
    }
  }

  failed(input: PresenterFailure) {
    if (input.kind === "usage_error") {
      writeStderr(`[skill-plugin-cli] 参数错误：${input.message}`);
      writeStderr("[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法");
      return;
    }
    if (input.kind === "cancelled") {
      writeStderr(`[skill-plugin-cli] 接入已取消：${input.message}`);
      return;
    }
    if (input.kind === "qrcode_error") {
      writeStderr(`[skill-plugin-cli] 接入失败：${input.message}`);
      writeStderr(`[skill-plugin-cli] 错误摘要：${formatQrFailureSummary(input.summary)}`);
      return;
    }
    writeStderr(`[skill-plugin-cli] 接入失败：${input.message}`);
  }
}
