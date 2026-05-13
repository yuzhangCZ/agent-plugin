import type { QrCodeAuthPort } from "../domain/ports.ts";
import { InstallCliError } from "../domain/errors.ts";
import type { CliQrFailureSummary, CliQrSnapshot, InstallContext } from "../domain/types.ts";
import type { QrCodeAuthRuntime, QrCodeAuthSnapshot } from "../domain/qrcode-types.ts";
import { embeddedQrCodeAuthRuntime } from "./embedded-qrcode-runtime.ts";

const DEFAULT_MAX_REFRESH_COUNT = 3;

function toCliFailureSummary(snapshot: Extract<QrCodeAuthSnapshot, { type: "failed" }>): CliQrFailureSummary {
  if (snapshot.reasonCode === "network_error") {
    return {
      type: "network_error",
      code: snapshot.serviceError?.code,
      message: snapshot.serviceError?.message,
    };
  }
  return {
    type: "auth_service_error",
    businessCode: snapshot.serviceError?.businessCode,
    error: snapshot.serviceError?.error,
    message: snapshot.serviceError?.message,
    httpStatus: snapshot.serviceError?.httpStatus,
  };
}

function toFailedInstallError(snapshot: Extract<QrCodeAuthSnapshot, { type: "failed" }>) {
  if (snapshot.reasonCode === "network_error") {
    return new InstallCliError(
      "QRCODE_AUTH_FAILED",
      "无法连接 WeLink 创建助理服务",
      JSON.stringify(toCliFailureSummary(snapshot)),
    );
  }
  if (snapshot.reasonCode === "timeout") {
    return new InstallCliError(
      "QRCODE_AUTH_FAILED",
      "WeLink 创建助理超时，请重新执行命令",
      JSON.stringify({ type: "auth_service_error" satisfies CliQrFailureSummary["type"] }),
    );
  }
  return new InstallCliError(
    "QRCODE_AUTH_FAILED",
    "WeLink 创建助理服务异常",
    JSON.stringify(toCliFailureSummary(snapshot)),
  );
}

export class QrCodeAuthAdapter implements QrCodeAuthPort {
  private readonly runtime: QrCodeAuthRuntime;

  constructor(runtime: QrCodeAuthRuntime = embeddedQrCodeAuthRuntime) {
    this.runtime = runtime;
  }

  async run(context: InstallContext, onSnapshot: (snapshot: CliQrSnapshot) => void) {
    let credentials: { ak: string; sk: string } | null = null;
    let refreshIndex = 0;
    let latestFailure: InstallCliError | null = null;
    await this.runtime.run({
      environment: context.environment,
      channel: context.channel,
      mac: context.mac,
      policy: {
        refreshOnExpired: true,
        maxRefreshCount: DEFAULT_MAX_REFRESH_COUNT,
      },
      onSnapshot(snapshot) {
        switch (snapshot.type) {
          case "qrcode_generated":
            onSnapshot({
              type: "qrcode_generated",
              weUrl: snapshot.display.weUrl,
              pcUrl: snapshot.display.pcUrl,
              expiresAt: snapshot.expiresAt,
              ...(refreshIndex > 0 ? { refresh: { index: refreshIndex, max: DEFAULT_MAX_REFRESH_COUNT } } : {}),
            });
            break;
          case "expired":
            refreshIndex += 1;
            onSnapshot({ type: "expired" });
            break;
          case "confirmed":
            credentials = snapshot.credentials;
            onSnapshot({ type: "confirmed" });
            break;
          case "cancelled":
            latestFailure = new InstallCliError("QRCODE_AUTH_CANCELLED", "WeLink 创建助理已取消");
            onSnapshot({ type: "cancelled", message: "WeLink 创建助理已取消" });
            break;
          case "failed":
            latestFailure = toFailedInstallError(snapshot);
            onSnapshot({
              type: "failed",
              message: latestFailure.message,
              summary: JSON.parse(latestFailure.details ?? "{\"type\":\"auth_service_error\"}") as CliQrFailureSummary,
            });
            break;
          case "scanned":
            break;
        }
      },
    });

    if (credentials) {
      return credentials;
    }
    if (latestFailure) {
      throw latestFailure;
    }
    throw new InstallCliError("QRCODE_AUTH_FAILED", "二维码授权未返回凭证。");
  }
}
