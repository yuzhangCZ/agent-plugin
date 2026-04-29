import { qrcodeAuth } from "@wecode/skill-qrcode-auth";
import type { QrCodeAuthRuntime } from "../domain/qrcode-types.ts";

/**
 * 发布态固定使用构建期内联的二维码授权运行时。
 */
export const embeddedQrCodeAuthRuntime: QrCodeAuthRuntime = qrcodeAuth;
