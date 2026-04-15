import {
  TRANSPORT_UPSTREAM_MESSAGE_TYPES,
  type RegisterOkMessage,
  type RegisterRejectedMessage,
  type WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

import type { GatewayWireCodec } from '../../ports/GatewayWireCodec.ts';
import type { GatewayBusinessMessage, GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import {
  extractGatewayMessageId,
  extractMessageAction,
  extractToolSessionId,
  extractWelinkSessionId,
  getMessageType,
} from '../telemetry/message-log-fields.ts';

const [, REGISTER_OK_MESSAGE_TYPE, REGISTER_REJECTED_MESSAGE_TYPE] = TRANSPORT_UPSTREAM_MESSAGE_TYPES;

function attachRawPayloadContext(message: GatewayBusinessMessage, raw: unknown): GatewayBusinessMessage {
  if (message.type !== 'invoke' || typeof raw !== 'object' || raw === null || !('payload' in raw)) {
    return message;
  }

  return {
    ...message,
    rawPayload: (raw as { payload?: unknown }).payload,
  };
}

function buildInvalidFrame(raw: unknown, messageType: string | undefined, violation: WireContractViolation): GatewayInboundFrame {
  return {
    kind: 'invalid',
    messageType,
    gatewayMessageId: extractGatewayMessageId(raw),
    action: extractMessageAction(raw),
    welinkSessionId: extractWelinkSessionId(raw),
    toolSessionId: extractToolSessionId(raw),
    violation,
    rawPreview: raw,
  };
}

/**
 * 入站协议适配器。
 * @remarks 负责把已解析的 JSON 对象收束成稳定的入站 envelope，区分 control / business / invalid。
 */
export class InboundProtocolAdapter {
  private readonly wireCodec: GatewayWireCodec;

  constructor(wireCodec: GatewayWireCodec) {
    this.wireCodec = wireCodec;
  }

  adapt(raw: unknown): GatewayInboundFrame {
    const messageType = getMessageType(raw);

    if (messageType === REGISTER_OK_MESSAGE_TYPE || messageType === REGISTER_REJECTED_MESSAGE_TYPE) {
      const validation = this.wireCodec.validateTransportMessage(raw);
      if (!validation.ok) {
        return buildInvalidFrame(raw, messageType, validation.error);
      }

      return {
        kind: 'control',
        messageType: validation.value.type,
        message: validation.value as RegisterOkMessage | RegisterRejectedMessage,
      };
    }

    const normalized = this.wireCodec.normalizeDownstream(raw);
    if (!normalized.ok) {
      return buildInvalidFrame(raw, messageType, normalized.error);
    }

    return {
      kind: 'business',
      messageType: normalized.value.type,
      message: attachRawPayloadContext(normalized.value, raw),
    };
  }
}
