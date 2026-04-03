import type {
  AbortSessionPayload,
  ChatPayload,
  CloseSessionPayload,
  DownstreamMessage as SharedDownstreamMessage,
  DownstreamMessageType,
  InvokeAction,
  InvokeMessage as SharedInvokeMessage,
  PermissionReplyPayload,
  QuestionReplyPayload,
  StatusQueryMessage,
} from "@agent-plugin/gateway-wire-v1";

export {
  ACTION_NAMES,
  DOWNSTREAM_MESSAGE_TYPES,
  INVOKE_ACTIONS,
} from "@agent-plugin/gateway-wire-v1";

export type {
  AbortSessionPayload,
  ChatPayload,
  CloseSessionPayload,
  DownstreamMessageType,
  InvokeAction,
  PermissionReplyPayload,
  QuestionReplyPayload,
  StatusQueryMessage,
} from "@agent-plugin/gateway-wire-v1";

// 这里保留 legacy create_session 兼容字段：原因是 openclaw 仍需在插件私有边界接收旧输入，
// 该形状不会进入共享 gateway-wire-v1 协议层。
export interface CreateSessionPayload {
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

type SharedCreateSessionInvokeMessage = Extract<SharedInvokeMessage, { action: "create_session" }>;

export type InvokeMessage =
  | Exclude<SharedInvokeMessage, SharedCreateSessionInvokeMessage>
  | (Omit<SharedCreateSessionInvokeMessage, "payload"> & { payload: CreateSessionPayload });

export type DownstreamMessage = Exclude<SharedDownstreamMessage, SharedCreateSessionInvokeMessage> | InvokeMessage | StatusQueryMessage;

export interface CreateSessionResultData {
  sessionId: string;
}
