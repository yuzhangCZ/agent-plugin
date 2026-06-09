import type { QrCodeAuthSnapshot } from "../types.ts";

function assertNever(value: never): never {
  throw new Error(`Unhandled qrcode auth snapshot: ${JSON.stringify(value)}`);
}

/**
 * 为轮询态事件生成稳定去重 key，避免把去重语义绑定到对象序列化实现。
 */
export function buildSnapshotKey(snapshot: QrCodeAuthSnapshot): string {
  switch (snapshot.type) {
    case "qrcode_generated":
      return `qrcode_generated:${snapshot.qrcode}`;
    case "scanned":
      return `scanned:${snapshot.qrcode}`;
    case "expired":
      return `expired:${snapshot.qrcode}`;
    case "cancelled":
      return `cancelled:${snapshot.qrcode}`;
    case "confirmed":
      return `confirmed:${snapshot.qrcode}`;
    case "failed":
      return `failed:${snapshot.qrcode ?? "session"}:${snapshot.reasonCode}`;
    default:
      return assertNever(snapshot);
  }
}
