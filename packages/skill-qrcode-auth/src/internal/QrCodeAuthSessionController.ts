import type { QrCodeAuthPolicy, QrCodeAuthSnapshot } from "../types.ts";
import type {
  CreatedQrCodeSession,
  QrCodeAuthFailureResult,
  QrCodeAuthServicePort,
  QueryQrCodeSessionResult,
} from "./service-port.ts";

type WaitFn = (ms: number) => Promise<void>;

/**
 * 负责二维码授权会话的状态推进、刷新和终态收口。
 */
export class QrCodeAuthSessionController {
  private readonly emittedKeys = new Set<string>();
  private readonly params: {
    service: QrCodeAuthServicePort;
    baseUrl: string;
    channel: string;
    mac: string;
    policy: Required<QrCodeAuthPolicy>;
    onSnapshot: (snapshot: QrCodeAuthSnapshot) => void;
    wait: WaitFn;
  };

  public constructor(params: {
    service: QrCodeAuthServicePort;
    baseUrl: string;
    channel: string;
    mac: string;
    policy: Required<QrCodeAuthPolicy>;
    onSnapshot: (snapshot: QrCodeAuthSnapshot) => void;
    wait: WaitFn;
  }) {
    this.params = params;
  }

  public async start(): Promise<void> {
    let refreshCount = 0;
    let activeSession = await this.createAndEmitSession();
    if (!activeSession) {
      return;
    }

    for (;;) {
      await this.params.wait(this.params.policy.pollIntervalMs);
      const queryResult = await this.params.service.querySession({
        baseUrl: this.params.baseUrl,
        ref: activeSession.ref,
      });

      const terminal = await this.handleQueryResult(queryResult);
      if (terminal) {
        return;
      }

      if (queryResult.kind !== "expired") {
        continue;
      }

      if (!this.params.policy.refreshOnExpired || refreshCount >= this.params.policy.maxRefreshCount) {
        this.emitSnapshot({
          type: "failed",
          qrcode: queryResult.qrcode,
          reasonCode: "timeout",
        });
        return;
      }

      refreshCount += 1;
      activeSession = await this.createAndEmitSession();
      if (!activeSession) {
        return;
      }
    }
  }

  private async createAndEmitSession(): Promise<CreatedQrCodeSession | null> {
    const result = await this.params.service.createSession({
      baseUrl: this.params.baseUrl,
      channel: this.params.channel,
      mac: this.params.mac,
    });
    if (result.kind === "failed") {
      this.emitFailure(result);
      return null;
    }

    this.emitSnapshot({
      type: "qrcode_generated",
      qrcode: result.session.ref.qrcode,
      display: result.session.display,
      expiresAt: result.session.expiresAt,
    });
    return result.session;
  }

  private async handleQueryResult(result: QueryQrCodeSessionResult): Promise<boolean> {
    switch (result.kind) {
      case "waiting":
        return false;
      case "scanned":
        this.emitSnapshot({
          type: "scanned",
          qrcode: result.qrcode,
        });
        return false;
      case "expired":
        this.emitSnapshot({
          type: "expired",
          qrcode: result.qrcode,
        });
        return false;
      case "cancelled":
        this.emitSnapshot({
          type: "cancelled",
          qrcode: result.qrcode,
        });
        return true;
      case "confirmed":
        this.emitSnapshot({
          type: "confirmed",
          qrcode: result.qrcode,
          credentials: result.credentials,
        });
        return true;
      case "failed":
        this.emitFailure(result);
        return true;
    }
  }

  private emitFailure(result: QrCodeAuthFailureResult): void {
    this.emitSnapshot({
      type: "failed",
      qrcode: result.qrcode,
      reasonCode: result.reasonCode,
      ...(result.serviceError ? { serviceError: result.serviceError } : {}),
    });
  }

  private emitSnapshot(snapshot: QrCodeAuthSnapshot): void {
    const key = JSON.stringify(snapshot);
    if (this.emittedKeys.has(key)) {
      return;
    }
    this.emittedKeys.add(key);
    this.params.onSnapshot(snapshot);
  }
}
