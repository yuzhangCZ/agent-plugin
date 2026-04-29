import { createRequire } from "node:module";
import process from "node:process";
import type { Presenter } from "../domain/ports.ts";
import { INSTALL_STAGE_LABELS } from "../domain/stages.ts";
import type { CliQrFailureSummary, CliQrSnapshot, HostAvailabilityResult, PresenterFailure } from "../domain/types.ts";

const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal") as {
  generate(input: string, options: { small?: boolean }, callback: (qrcode: string) => void): void;
};

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
  return [
    `下一步：请重启 ${host} 以使插件与配置生效`,
  ];
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

export class TerminalCliPresenter implements Presenter {
  private readonly qrCodeRenderer: (data: string) => string;

  constructor(qrCodeRenderer: (data: string) => string = renderQrCode) {
    this.qrCodeRenderer = qrCodeRenderer;
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
          writeStdout("[skill-plugin-cli] ========= 已刷新二维码（第 "
            + `${snapshot.refresh.index}/${snapshot.refresh.max} 次） =========`);
          writeStdout();
        } else {
          writeStdout("[skill-plugin-cli] 请使用 WeLink 扫码创建助理");
        }
        try {
          writeStdout(this.qrCodeRenderer(snapshot.weUrl));
        } catch {
          writeStdout(`[skill-plugin-cli] weUrl: ${snapshot.weUrl}`);
        }
        writeStdout(`[skill-plugin-cli] pc WeLink 创建助理地址: ${snapshot.pcUrl}`);
        writeStdout(`[skill-plugin-cli] 二维码有效期至: ${formatUtcTimestamp(snapshot.expiresAt)}`);
        writeStdout("[skill-plugin-cli] 请在 WeLink 中创建助理");
        return;
      }
      case "expired":
        writeStdout("[skill-plugin-cli] 二维码已过期，正在刷新");
        writeStdout();
        return;
      case "confirmed":
        return;
      case "cancelled":
        return;
      case "failed":
        return;
    }
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
