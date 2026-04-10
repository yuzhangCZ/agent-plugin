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
  /** 归一化入站消息；失败时返回结构化协议违约信息。 */
  normalizeDownstream(raw: unknown): { ok: true; value: DownstreamMessage } | { ok: false; error: WireContractViolation };
  /** 校验发送消息是否满足 transport 协议契约。 */
  validateTransportMessage(
    raw: unknown,
  ): { ok: true; value: UpstreamTransportMessage } | { ok: false; error: WireContractViolation };
}
