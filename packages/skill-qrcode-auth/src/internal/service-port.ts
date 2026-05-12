import type {
  QrCodeAuthFailureReasonCode,
  QrCodeAuthServiceError,
  QrCodeDisplayData,
} from "../types.ts";

export interface QrCodeSessionRef {
  qrcode: string;
  accessToken: string;
}

export interface CreatedQrCodeSession {
  ref: QrCodeSessionRef;
  display: QrCodeDisplayData;
  expiresAt: string;
}

export type QrCodeAuthFailureResult = {
  kind: "failed";
  qrcode?: string;
  reasonCode: QrCodeAuthFailureReasonCode;
  serviceError?: QrCodeAuthServiceError;
};

export type CreateQrCodeSessionResult =
  | {
      kind: "created";
      session: CreatedQrCodeSession;
    }
  | QrCodeAuthFailureResult;

export type QueryQrCodeSessionResult =
  | {
      kind: "waiting";
      qrcode: string;
    }
  | {
      kind: "scanned";
      qrcode: string;
    }
  | {
      kind: "expired";
      qrcode: string;
    }
  | {
      kind: "cancelled";
      qrcode: string;
    }
  | {
      kind: "confirmed";
      qrcode: string;
      credentials: {
        ak: string;
        sk: string;
      };
    }
  | QrCodeAuthFailureResult;

/**
 * application 层唯一可见的远端授权能力。
 */
export interface QrCodeAuthServicePort {
  /**
   * 创建新的二维码授权会话。
   */
  createSession(input: {
    baseUrl: string;
    channel: string;
    mac: string;
  }): Promise<CreateQrCodeSessionResult>;

  /**
   * 查询当前二维码会话的最新状态。
   */
  querySession(input: {
    baseUrl: string;
    ref: QrCodeSessionRef;
  }): Promise<QueryQrCodeSessionResult>;
}
