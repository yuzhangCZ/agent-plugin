import { TRANSPORT_UPSTREAM_MESSAGE_TYPES, type RegisterOkMessage, type RegisterRejectedMessage } from '@agent-plugin/gateway-wire-v1';

import type { GatewayWireCodec } from '../../ports/GatewayWireCodec.ts';
import type { GatewayBusinessMessage, GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import { getMessageType } from '../telemetry/message-log-fields.ts';

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
        return {
          kind: 'invalid',
          messageType,
          violation: validation.error,
          rawPreview: raw,
        };
      }

      return {
        kind: 'control',
        messageType: validation.value.type,
        message: validation.value as RegisterOkMessage | RegisterRejectedMessage,
      };
    }

    const normalized = this.wireCodec.normalizeDownstream(raw);
    if (!normalized.ok) {
      return {
        kind: 'invalid',
        messageType,
        violation: normalized.error,
        rawPreview: raw,
      };
    }

    return {
      kind: 'business',
      messageType: normalized.value.type,
      message: attachRawPayloadContext(normalized.value, raw),
    };
  }
}
