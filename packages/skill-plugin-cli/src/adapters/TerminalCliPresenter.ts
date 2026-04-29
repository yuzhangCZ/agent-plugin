import { createRequire } from "node:module";
import process from "node:process";
import type { Presenter } from "../domain/ports.ts";
import type { QrCodeAuthSnapshot } from "../domain/qrcode-types.ts";
import type { InstallContext, InstalledPluginArtifact } from "../domain/types.ts";
import type { InstallStageName } from "../domain/stages.ts";

const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal") as {
  generate(input: string, options: { small?: boolean }, callback: (qrcode: string) => void): void;
};
const supportsHyperlinks = require("supports-hyperlinks") as {
  stdout: boolean;
  stderr: boolean;
};

function writeLine(message: string) {
  process.stdout.write(`${message}\n`);
}

function writeError(message: string) {
  process.stderr.write(`${message}\n`);
}

function renderQrCode(data: string) {
  let rendered = "";
  qrcodeTerminal.generate(data, { small: true }, (qrcode) => {
    rendered = qrcode.replace(/\s*$/u, "");
  });
  return rendered;
}

function formatTerminalHyperlink(label: string, url: string) {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export class TerminalCliPresenter implements Presenter {
  private readonly qrCodeRenderer: (data: string) => string;
  private readonly stdoutSupportsHyperlinks: boolean;

  constructor(
    qrCodeRenderer: (data: string) => string = renderQrCode,
    stdoutSupportsHyperlinks = supportsHyperlinks.stdout,
  ) {
    this.qrCodeRenderer = qrCodeRenderer;
    this.stdoutSupportsHyperlinks = stdoutSupportsHyperlinks;
  }

  stageStarted(stage: InstallStageName, context: InstallContext) {
    writeLine(`[skill-plugin-cli][${context.host}] 开始：${stage}`);
  }

  stageSucceeded(stage: InstallStageName, detail?: string) {
    writeLine(`[skill-plugin-cli] 完成：${stage}${detail ? ` · ${detail}` : ""}`);
  }

  stageFailed(stage: InstallStageName, message: string) {
    writeError(`[skill-plugin-cli] 失败：${stage} · ${message}`);
  }

  info(message: string) {
    writeLine(`[skill-plugin-cli] ${message}`);
  }

  qrSnapshot(snapshot: QrCodeAuthSnapshot) {
    switch (snapshot.type) {
      case "qrcode_generated":
        writeLine("[skill-plugin-cli] 二维码已生成，请扫码授权。");
        try {
          writeLine(this.qrCodeRenderer(snapshot.display.weUrl));
        } catch {
          writeLine(`weUrl: ${snapshot.display.weUrl}`);
        }
        if (this.stdoutSupportsHyperlinks) {
          writeLine(`pcUrl: ${formatTerminalHyperlink("打开浏览器授权", snapshot.display.pcUrl)}`);
          writeLine(`pcUrl: ${snapshot.display.pcUrl}`);
        } else {
          writeLine(`pcUrl（可复制打开）: ${snapshot.display.pcUrl}`);
        }
        writeLine(`expiresAt: ${snapshot.expiresAt}`);
        break;
      case "scanned":
        writeLine(`[skill-plugin-cli] 已扫码，等待确认：${snapshot.qrcode}`);
        break;
      case "expired":
        writeLine(`[skill-plugin-cli] 当前二维码已过期，等待刷新：${snapshot.qrcode}`);
        break;
      case "confirmed":
        writeLine(`[skill-plugin-cli] 二维码确认完成：${snapshot.qrcode}`);
        break;
      case "cancelled":
        writeLine(`[skill-plugin-cli] 二维码授权已取消：${snapshot.qrcode}`);
        break;
      case "failed":
        writeError(`[skill-plugin-cli] 二维码授权失败：${snapshot.reasonCode}${snapshot.qrcode ? ` (${snapshot.qrcode})` : ""}`);
        break;
    }
  }

  warning(message: string) {
    writeLine(`[skill-plugin-cli][warning] ${message}`);
  }

  selectedInstallStrategy(context: InstallContext) {
    writeLine(`[skill-plugin-cli] 当前安装策略：${context.installStrategy}`);
  }

  fallbackArtifactResolved(artifact: InstalledPluginArtifact) {
    writeLine(
      `[skill-plugin-cli] fallback 产物已解析：package=${artifact.packageName}`
        + `${artifact.packageVersion ? ` version=${artifact.packageVersion}` : ""}`
        + `${artifact.localTarballPath ? ` tarball=${artifact.localTarballPath}` : ""}`,
    );
  }

  fallbackApplied(artifact: InstalledPluginArtifact) {
    writeLine(`[skill-plugin-cli] fallback 已写入宿主目标：pluginSpec=${artifact.pluginSpec}`);
  }

  success(summary: string, nextSteps: string[] = []) {
    writeLine(`[skill-plugin-cli] 安装成功：${summary}`);
    for (const nextStep of nextSteps) {
      writeLine(`[skill-plugin-cli] ${nextStep}`);
    }
  }

  failure(summary: string) {
    writeError(`[skill-plugin-cli] 安装失败：${summary}`);
  }

  cancelled(summary: string) {
    writeError(`[skill-plugin-cli] 安装已取消：${summary}`);
  }
}
