import {
  normalizeDownstream,
  validateUpstreamMessage,
  type DownstreamMessage,
  type UpstreamTransportMessage,
  type WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

import type { GatewayWireCodec } from '../ports/GatewayWireCodec.ts';

/**
 * gateway-wire-v1 的编解码适配实现。
 */
export class GatewayWireV1CodecAdapter implements GatewayWireCodec {
  normalizeDownstream(raw: unknown): { ok: true; value: DownstreamMessage } | { ok: false; error: WireContractViolation } {
    return normalizeDownstream(raw);
  }

  validateTransportMessage(
    raw: unknown,
  ): { ok: true; value: UpstreamTransportMessage } | { ok: false; error: WireContractViolation } {
    return validateUpstreamMessage(raw);
  }
}
