import type {
  AbortSessionPayload,
  ChatPayload,
  CloseSessionPayload,
  GatewayDownstreamBusinessRequest as SharedDownstreamBusinessRequest,
  DownstreamMessageType,
  InvokeAction,
  InvokeMessage as SharedInvokeMessage,
  PermissionReplyPayload,
  QuestionReplyPayload,
  StatusQueryMessage,
} from "@agent-plugin/gateway-schema";

export {
  ACTION_NAMES,
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
} from "@agent-plugin/gateway-schema";

export type {
  AbortSessionPayload,
  ChatPayload,
  CloseSessionPayload,
  DownstreamMessageType,
  InvokeAction,
  PermissionReplyPayload,
  QuestionReplyPayload,
  StatusQueryMessage,
} from "@agent-plugin/gateway-schema";

// 这里保留 legacy create_session 兼容字段：原因是 openclaw 仍需在插件私有边界吸收旧输入，
// 但该字段已经废弃，只允许被解析并忽略，不再影响最终 session identity。
export interface CreateSessionPayload {
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

type SharedCreateSessionInvokeMessage = Extract<SharedInvokeMessage, { action: "create_session" }>;

export type InvokeMessage =
  | Exclude<SharedInvokeMessage, SharedCreateSessionInvokeMessage>
  | (Omit<SharedCreateSessionInvokeMessage, "payload"> & { payload: CreateSessionPayload });

export type DownstreamMessage = Exclude<SharedDownstreamBusinessRequest, SharedCreateSessionInvokeMessage> | InvokeMessage | StatusQueryMessage;

export interface CreateSessionResultData {
  sessionId: string;
}
