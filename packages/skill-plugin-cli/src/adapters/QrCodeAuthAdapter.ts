import type { QrCodeAuthPort } from "../domain/ports.ts";
import { InstallCliError } from "../domain/errors.ts";
import type { InstallContext } from "../domain/types.ts";
import type { QrCodeAuthRuntime, QrCodeAuthSnapshot } from "../domain/qrcode-types.ts";
import { embeddedQrCodeAuthRuntime } from "./embedded-qrcode-runtime.ts";

export class QrCodeAuthAdapter implements QrCodeAuthPort {
  private readonly runtime: QrCodeAuthRuntime;

  constructor(runtime: QrCodeAuthRuntime = embeddedQrCodeAuthRuntime) {
    this.runtime = runtime;
  }

  async run(context: InstallContext, onSnapshot: (snapshot: QrCodeAuthSnapshot) => void) {
    let credentials: { ak: string; sk: string } | null = null;
    let terminalStatus: "confirmed" | "failed" | "cancelled" | null = null;
    let failureReason: string | null = null;
    await this.runtime.run({
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
