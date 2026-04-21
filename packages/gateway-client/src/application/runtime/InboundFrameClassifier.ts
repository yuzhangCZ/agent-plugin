import {
  REGISTER_OK_MESSAGE_TYPE,
  REGISTER_REJECTED_MESSAGE_TYPE,
} from '@agent-plugin/gateway-schema';

import { InboundFrameDecoder, type InboundFrameDecodeResult } from '../protocol/InboundFrameDecoder.ts';
import { InboundProtocolAdapter } from '../protocol/InboundProtocolAdapter.ts';
import type { GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import type { GatewayRuntimeContext } from './GatewayRuntimeContracts.ts';
import type { GatewayWireCodec } from '../../ports/GatewayWireCodec.ts';

type NonParsedInboundFrame = Exclude<InboundFrameDecodeResult, { kind: 'parsed' }>;

export type InboundClassificationResult =
  | { kind: 'nonparsed'; frame: NonParsedInboundFrame }
  | { kind: 'handshake-control'; frame: GatewayInboundFrame & { kind: 'control' } }
  | { kind: 'invalid-handshake'; frame: GatewayInboundFrame & { kind: 'invalid' } }
  | {
    kind: 'business';
    frame: GatewayInboundFrame & { kind: 'business' };
    messageType: string | undefined;
    gatewayMessageId: string | undefined;
  }
  | {
    kind: 'invalid-business';
    frame: GatewayInboundFrame & { kind: 'invalid' };
    messageType: string | undefined;
    gatewayMessageId: string | undefined;
  };

/**
 * 入站帧分类器。
 * @remarks 统一负责 decode + adapt + classify，不参与连接裁决。
 */
export class InboundFrameClassifier {
  private readonly decoder = new InboundFrameDecoder();
  private readonly adapter: InboundProtocolAdapter;
  private readonly context: GatewayRuntimeContext;

  constructor(context: GatewayRuntimeContext, wireCodec: GatewayWireCodec) {
    this.context = context;
    this.adapter = new InboundProtocolAdapter(wireCodec);
  }

  async classify(event: { data: string | ArrayBuffer | Blob | Uint8Array }): Promise<InboundClassificationResult> {
    this.context.telemetry.logRawFrame('onMessage', event.data);
    const decoded = await this.decoder.decode(event.data);
    if (decoded.kind !== 'parsed') {
      return { kind: 'nonparsed', frame: decoded };
    }

    const frameBytes = Buffer.byteLength(decoded.rawText, 'utf8');
    const parsed = decoded.value;
    const { messageType, gatewayMessageId } = this.context.telemetry.markReceived(parsed, frameBytes);
    const inboundFrame = this.adapter.adapt(parsed);

    if (messageType === REGISTER_OK_MESSAGE_TYPE || messageType === REGISTER_REJECTED_MESSAGE_TYPE) {
      if (inboundFrame.kind === 'control') {
        return { kind: 'handshake-control', frame: inboundFrame };
      }
      if (inboundFrame.kind === 'invalid') {
        return { kind: 'invalid-handshake', frame: inboundFrame };
      }
      throw new Error(`Unexpected handshake inbound frame kind: ${inboundFrame.kind}`);
    }

    if (inboundFrame.kind === 'invalid') {
      return {
        kind: 'invalid-business',
        frame: inboundFrame,
        messageType,
        gatewayMessageId,
      };
    }

    if (inboundFrame.kind !== 'business') {
      throw new Error(`Unexpected inbound frame kind: ${inboundFrame.kind}`);
    }

    return {
      kind: 'business',
      frame: inboundFrame,
      messageType,
      gatewayMessageId,
    };
  }
}
