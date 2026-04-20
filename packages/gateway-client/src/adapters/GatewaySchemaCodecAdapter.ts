import {
  GatewaySchemaFacade,
  type GatewayTransportMessage,
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
  private readonly schemaFacade = new GatewaySchemaFacade();

  normalizeDownstream(raw: unknown): { ok: true; value: GatewayDownstreamBusinessRequest } | { ok: false; error: WireContractViolation } {
    return this.schemaFacade.normalizeDownstream(raw);
  }

  validateGatewayUplinkBusinessMessage(
    raw: unknown,
  ): { ok: true; value: GatewayUplinkBusinessMessage } | { ok: false; error: WireContractViolation } {
    return this.schemaFacade.validateGatewayUplinkBusinessMessage(raw);
  }

  validateGatewayTransportMessage(
    raw: unknown,
  ): { ok: true; value: GatewayTransportMessage } | { ok: false; error: WireContractViolation } {
    return this.schemaFacade.validateGatewayTransportMessage(raw);
  }

  validateGatewayWireProtocolMessage(
    raw: unknown,
  ): { ok: true; value: GatewayWireProtocol } | { ok: false; error: WireContractViolation } {
    return this.schemaFacade.validateGatewayWireProtocolMessage(raw);
  }
}
