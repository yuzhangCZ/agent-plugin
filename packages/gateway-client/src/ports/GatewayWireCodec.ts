import type {
  DownstreamMessage,
  UpstreamTransportMessage,
  WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

/**
 * wire 协议编解码端口。
 * @remarks runtime 只依赖该端口，确保协议实现可替换且可测试。
 */
export interface GatewayWireCodec {
  normalizeDownstream(raw: unknown): { ok: true; value: DownstreamMessage } | { ok: false; error: WireContractViolation };
  validateTransportMessage(
    raw: unknown,
  ): { ok: true; value: UpstreamTransportMessage } | { ok: false; error: WireContractViolation };
}
