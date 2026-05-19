import type {
  AbortSessionPayload,
  ChatPayload,
  CloseSessionPayload,
  GatewayDownstreamBusinessRequest,
  DownstreamMessageType,
  InvokeAction,
  InvokeMessage,
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
  GatewayDownstreamBusinessRequest,
  InvokeMessage,
  InvokeAction,
  PermissionReplyPayload,
  QuestionReplyPayload,
  StatusQueryMessage,
} from "@agent-plugin/gateway-schema";

export type DownstreamMessage = GatewayDownstreamBusinessRequest;

export interface CreateSessionResultData {
  sessionId: string;
}
