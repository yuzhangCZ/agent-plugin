import type {
  DownstreamMessage,
  UpstreamTransportMessage,
  WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

export interface GatewayWireCodec {
  normalizeDownstream(raw: unknown): { ok: true; value: DownstreamMessage } | { ok: false; error: WireContractViolation };
  validateTransportMessage(
    raw: unknown,
  ): { ok: true; value: UpstreamTransportMessage } | { ok: false; error: WireContractViolation };
}
