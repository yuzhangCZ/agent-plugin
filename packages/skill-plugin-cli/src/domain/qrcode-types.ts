export type QrCodeAuthEnvironment = "uat" | "prod";

export interface QrCodeDisplayData {
  qrcode: string;
  weUrl: string;
  pcUrl: string;
}

export interface QrCodeAuthServiceError {
  httpStatus?: number;
  businessCode?: string;
  error?: string;
  message?: string;
  errorEn?: string;
}

export type QrCodeAuthFailureReasonCode = "timeout" | "network_error" | "auth_service_error";

export type QrCodeAuthSnapshot =
  | {
      type: "qrcode_generated";
      qrcode: string;
      display: QrCodeDisplayData;
      expiresAt: string;
    }
  | {
      type: "scanned";
      qrcode: string;
    }
  | {
      type: "expired";
      qrcode: string;
    }
  | {
      type: "cancelled";
      qrcode: string;
    }
  | {
      type: "confirmed";
      qrcode: string;
      credentials: {
        ak: string;
        sk: string;
      };
    }
  | {
      type: "failed";
      qrcode?: string;
      reasonCode: QrCodeAuthFailureReasonCode;
      serviceError?: QrCodeAuthServiceError;
    };

export interface QrCodeAuthRunInput {
  environment?: QrCodeAuthEnvironment;
  channel: string;
  mac: string;
  onSnapshot: (snapshot: QrCodeAuthSnapshot) => void;
}

export interface QrCodeAuthRuntime {
  run(input: QrCodeAuthRunInput): Promise<void>;
}
