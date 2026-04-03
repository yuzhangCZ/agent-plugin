import {
  TOOL_ERROR_REASONS,
  TRANSPORT_UPSTREAM_MESSAGE_TYPES,
  validateUpstreamMessage,
} from "@agent-plugin/gateway-wire-v1";

export { TOOL_ERROR_REASONS, TRANSPORT_UPSTREAM_MESSAGE_TYPES, validateUpstreamMessage } from "@agent-plugin/gateway-wire-v1";

export const UPSTREAM_MESSAGE_TYPE = {
  REGISTER: "register",
  REGISTER_OK: "register_ok",
  REGISTER_REJECTED: "register_rejected",
  HEARTBEAT: "heartbeat",
  TOOL_EVENT: "tool_event",
  TOOL_DONE: "tool_done",
  TOOL_ERROR: "tool_error",
  SESSION_CREATED: "session_created",
  STATUS_RESPONSE: "status_response",
} as const;

export const TOOL_ERROR_REASON = {
  SESSION_NOT_FOUND: TOOL_ERROR_REASONS[0],
} as const;

export type {
  ToolErrorReason,
  RegisterMessage,
  HeartbeatMessage,
  ToolEventMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  SessionCreatedMessage,
  StatusResponseMessage,
  UpstreamTransportMessage as UpstreamMessage,
} from "@agent-plugin/gateway-wire-v1";
