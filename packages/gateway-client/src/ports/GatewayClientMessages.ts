import type {
  GatewayDownstreamBusinessRequest,
  GatewayUplinkBusinessMessage,
  HeartbeatMessage,
  RegisterMessage,
  RegisterOkMessage,
  RegisterRejectedMessage,
  WireContractViolation,
} from '@agent-plugin/gateway-schema';

/**
 * 业务层可消费的下行消息，只保留稳定的 downstream 契约。
 */
export type GatewayBusinessMessage = GatewayDownstreamBusinessRequest;

/**
 * 入站帧的结构化观测结果，用于区分解码失败、协议错误和已识别消息。
 */
export type GatewayInboundFrame =
  | { kind: 'decode_error'; reason: 'unsupported_binary_frame' | 'text_decode_failed'; rawPreview?: string }
  | { kind: 'parse_error'; rawPreview: string }
  | { kind: 'control'; messageType: string; message: RegisterOkMessage | RegisterRejectedMessage }
  | { kind: 'business'; messageType: string; message: GatewayBusinessMessage; rawPayload?: unknown }
  | {
    kind: 'invalid';
    messageType?: string;
    gatewayMessageId?: string;
    action?: string;
    welinkSessionId?: string;
    toolSessionId?: string;
    violation: WireContractViolation;
    rawPreview: unknown;
  };

/**
 * 统一出站观测契约，覆盖业务负载与内部控制帧。
 */
export type GatewayOutboundMessage = GatewayUplinkBusinessMessage | RegisterMessage | HeartbeatMessage;

/**
 * 对外发送入口只接受业务负载，控制帧由运行时内部编排。
 */
export type GatewaySendPayload = GatewayUplinkBusinessMessage;
