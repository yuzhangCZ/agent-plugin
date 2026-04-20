import type {
  GatewayDownstreamBusinessRequest,
  GatewayUplinkBusinessMessage,
  GatewayWireProtocol,
  WireContractViolation,
} from '@agent-plugin/gateway-schema';

/**
 * wire 协议编解码端口。
 * @remarks runtime 只依赖该端口，确保协议实现可替换且可测试。
 */
export interface GatewayWireCodec {
  /** 归一化入站消息；失败时返回结构化协议违约信息。 */
  normalizeDownstream(raw: unknown): { ok: true; value: GatewayDownstreamBusinessRequest } | { ok: false; error: WireContractViolation };
  /** 校验业务上行消息是否满足共享业务消息契约。 */
  validateGatewayUplinkBusinessMessage(
    raw: unknown,
  ): { ok: true; value: GatewayUplinkBusinessMessage } | { ok: false; error: WireContractViolation };
  /** 校验 current-state 全量 wire protocol frame。 */
  validateGatewayWireProtocolMessage(raw: unknown): { ok: true; value: GatewayWireProtocol } | { ok: false; error: WireContractViolation };
}
