import { createQrCodeAuthRuntime } from "./internal/createQrCodeAuthRuntime.ts";

export type {
  QrCodeAuth,
  QrCodeAuthFailureReasonCode,
  QrCodeAuthEnvironment,
  QrCodeAuthPolicy,
  QrCodeAuthRunInput,
  QrCodeAuthServiceError,
  QrCodeAuthSnapshot,
  QrCodeDisplayData,
} from "./types.ts";

/**
 * 默认二维码授权 runtime。模块级实例不持有单次会话状态，`run()` 可重复调用。
 */
export const qrcodeAuth = createQrCodeAuthRuntime();
