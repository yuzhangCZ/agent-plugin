/**
 * 入站帧解码结果。
 * @remarks 只承载“是否成功解析出 JSON 对象”的结果，不负责协议分类。
 */
export type InboundFrameDecodeResult =
  | { kind: 'parsed'; value: unknown; rawText: string }
  | { kind: 'parse_error'; rawPreview: string }
  | { kind: 'decode_error'; reason: 'unsupported_binary_frame' | 'text_decode_failed' };

/**
 * 入站帧解码器。
 * @remarks 这里仅允许文本 JSON 进入后续协议层；二进制帧统一视为不支持，避免 router 里继续做隐式兼容。
 */
export class InboundFrameDecoder {
  async decode(data: string | Blob | ArrayBuffer | Uint8Array): Promise<InboundFrameDecodeResult> {
    if (typeof data !== 'string') {
      return { kind: 'decode_error', reason: 'unsupported_binary_frame' };
    }

    try {
      return { kind: 'parsed', value: JSON.parse(data), rawText: data };
    } catch {
      return { kind: 'parse_error', rawPreview: data };
    }
  }
}
