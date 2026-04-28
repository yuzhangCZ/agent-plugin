import { pathToFileURL } from "node:url";
import type { QrCodeAuthPort } from "../domain/ports.ts";
import { InstallCliError } from "../domain/errors.ts";
import type { InstallContext } from "../domain/types.ts";
import type { QrCodeAuthRuntime, QrCodeAuthSnapshot } from "../domain/qrcode-types.ts";

async function loadRuntimeFromOverride(overridePath: string) {
  const module = await import(pathToFileURL(overridePath).href);
  if (typeof module.qrcodeAuth?.run !== "function") {
    throw new InstallCliError("QRCODE_AUTH_FAILED", "二维码授权模块必须导出 qrcodeAuth.run(input)。");
  }
  return module.qrcodeAuth as QrCodeAuthRuntime;
}

export class QrCodeAuthAdapter implements QrCodeAuthPort {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env = process.env) {
    this.env = env;
  }

  private async loadRuntime() {
    const override = this.env.SKILL_PLUGIN_CLI_QRCODE_AUTH_MODULE
      || this.env.MB_SETUP_QRCODE_AUTH_MODULE
      || this.env.OPENCLAW_INSTALL_QRCODE_AUTH_MODULE;
    if (override?.trim()) {
      return await loadRuntimeFromOverride(override.trim());
    }
    const attempts = [
      () => import("@wecode/skill-qrcode-auth"),
      () => import(new URL("../../../skill-qrcode-auth/src/index.ts", import.meta.url).href),
    ];

    for (const load of attempts) {
      try {
        const module = await load();
        if (typeof module.qrcodeAuth?.run === "function") {
          return module.qrcodeAuth as QrCodeAuthRuntime;
        }
      } catch {
        continue;
      }
    }
    throw new InstallCliError("QRCODE_AUTH_FAILED", "无法加载二维码授权运行时。");
  }

  async run(context: InstallContext, onSnapshot: (snapshot: QrCodeAuthSnapshot) => void) {
    const runtime = await this.loadRuntime();
    let credentials: { ak: string; sk: string } | null = null;
    let terminalStatus: "confirmed" | "failed" | "cancelled" | null = null;
    let failureReason: string | null = null;
    await runtime.run({
      environment: context.environment,
      channel: context.channel,
      mac: context.mac,
      onSnapshot(snapshot: QrCodeAuthSnapshot) {
        onSnapshot(snapshot);
        if (snapshot.type === "confirmed") {
          credentials = snapshot.credentials;
        }
        if (snapshot.type === "confirmed" || snapshot.type === "failed" || snapshot.type === "cancelled") {
          terminalStatus = snapshot.type;
          if (snapshot.type === "failed") {
            failureReason = snapshot.reasonCode;
          }
        }
      },
    });

    if (credentials) {
      return credentials;
    }
    if (terminalStatus === "cancelled") {
      throw new InstallCliError("QRCODE_AUTH_CANCELLED", "二维码授权已取消。");
    }
    if (terminalStatus === "failed") {
      throw new InstallCliError("QRCODE_AUTH_FAILED", `二维码授权失败：${failureReason ?? "unknown"}`);
    }
    throw new InstallCliError("QRCODE_AUTH_FAILED", "二维码授权未返回凭证。");
  }
}
