import type {
  DownstreamMessage,
  HeartbeatMessage,
  RegisterMessage,
  RegisterOkMessage,
  RegisterRejectedMessage,
  SessionCreatedMessage,
  StatusResponseMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  ToolEventMessage,
  WireContractViolation,
} from '@agent-plugin/gateway-wire-v1';

/**
 * 业务层可消费的下行消息，只保留稳定的 downstream 契约。
 * @remarks `rawPayload` 仅作为迁移期插件私有兼容上下文，不应替代共享协议主链路。
 */
export type GatewayBusinessMessage = DownstreamMessage & { rawPayload?: unknown };

/**
 * 入站帧的结构化观测结果，用于区分解码失败、协议错误和已识别消息。
 */
export type GatewayInboundFrame =
  | { kind: 'decode_error'; reason: 'unsupported_binary_frame' | 'text_decode_failed'; rawPreview?: string }
  | { kind: 'parse_error'; rawPreview: string }
  | { kind: 'control'; messageType: string; message: RegisterOkMessage | RegisterRejectedMessage }
  | { kind: 'business'; messageType: string; message: GatewayBusinessMessage }
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
export type GatewayOutboundMessage = GatewaySendPayload | RegisterMessage | HeartbeatMessage;

/**
 * 对外发送入口只接受业务负载，控制帧由运行时内部编排。
 */
export type GatewaySendPayload =
  | ToolEventMessage
  | ToolDoneMessage
  | ToolErrorMessage
  | SessionCreatedMessage
  | StatusResponseMessage;
