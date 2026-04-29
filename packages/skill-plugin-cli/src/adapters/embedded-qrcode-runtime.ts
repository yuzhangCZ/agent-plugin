import { qrcodeAuth } from "../../../skill-qrcode-auth/src/index.ts";
import type { QrCodeAuthRuntime } from "../domain/qrcode-types.ts";

/**
 * 临时直接引用 workspace 源码入口，解除对已构建 dist 的隐式依赖。
 */
export const embeddedQrCodeAuthRuntime: QrCodeAuthRuntime = qrcodeAuth;
