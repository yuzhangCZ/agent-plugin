import {
  normalizeDownstream,
  validateGatewayUplinkBusinessMessage,
  validateGatewayWireProtocolMessage,
  type GatewayDownstreamBusinessRequest,
  type GatewayUplinkBusinessMessage,
  type GatewayWireProtocol,
  type WireContractViolation,
} from '@agent-plugin/gateway-schema';

import type { GatewayWireCodec } from '../ports/GatewayWireCodec.ts';

/**
 * gateway-schema 的编解码适配实现。
 */
export class GatewaySchemaCodecAdapter implements GatewayWireCodec {
  normalizeDownstream(raw: unknown): { ok: true; value: GatewayDownstreamBusinessRequest } | { ok: false; error: WireContractViolation } {
    return normalizeDownstream(raw);
  }

  validateGatewayUplinkBusinessMessage(
    raw: unknown,
  ): { ok: true; value: GatewayUplinkBusinessMessage } | { ok: false; error: WireContractViolation } {
    return validateGatewayUplinkBusinessMessage(raw);
  }

  validateGatewayWireProtocolMessage(
    raw: unknown,
  ): { ok: true; value: GatewayWireProtocol } | { ok: false; error: WireContractViolation } {
    return validateGatewayWireProtocolMessage(raw);
  }
}
