import { qrcodeAuth } from "../../../skill-qrcode-auth/src/index.ts";
import type { QrCodeAuthRuntime } from "../domain/qrcode-types.ts";

/**
 * 继续直接引用 workspace 源码入口，避免将二维码授权 runtime 误建模为对外包依赖契约。
 */
export const embeddedQrCodeAuthRuntime: QrCodeAuthRuntime = qrcodeAuth;
