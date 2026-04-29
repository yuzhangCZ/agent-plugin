/**
 * 二维码展示层消费的数据，不包含渲染策略。
 */
export interface QrCodeDisplayData {
  qrcode: string;
  weUrl: string;
  pcUrl: string;
}

/**
 * 授权服务错误的安全子集，不透传敏感上下文。
 */
export interface QrCodeAuthServiceError {
  code?: string;
  httpStatus?: number;
  businessCode?: string;
  error?: string;
  message?: string;
  errorEn?: string;
}

export type QrCodeAuthFailureReasonCode = "timeout" | "network_error" | "auth_service_error";

/**
 * 二维码授权固定环境枚举。
 */
export type QrCodeAuthEnvironment = "uat" | "prod";

/**
 * 调用方可感知的二维码授权事件。
 */
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

/**
 * 控制自动刷新与轮询节奏的策略。
 */
export interface QrCodeAuthPolicy {
  refreshOnExpired?: boolean;
  maxRefreshCount?: number;
  pollIntervalMs?: number;
}

/**
 * `run()` 的完整输入。
 */
export interface QrCodeAuthRunInput {
  /**
   * 授权环境；未传时默认 `prod`。
   */
  environment?: QrCodeAuthEnvironment;
  channel: string;
  mac: string;
  policy?: QrCodeAuthPolicy;
  onSnapshot: (snapshot: QrCodeAuthSnapshot) => void;
}

/**
 * 对外暴露的唯一高层授权入口。
 */
export interface QrCodeAuth {
  run(input: QrCodeAuthRunInput): Promise<void>;
}
