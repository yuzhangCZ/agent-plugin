import {
  type GatewayUplinkBusinessMessage,
  TOOL_ERROR_REASONS,
  TRANSPORT_UPSTREAM_MESSAGE_TYPES,
  validateGatewayUplinkBusinessMessage,
} from '@agent-plugin/gateway-schema';

export const TOOL_ERROR_REASON = {
  SESSION_NOT_FOUND: TOOL_ERROR_REASONS[0],
} as const;

export const UPSTREAM_MESSAGE_TYPE = {
  REGISTER: 'register',
  REGISTER_OK: 'register_ok',
  REGISTER_REJECTED: 'register_rejected',
  HEARTBEAT: 'heartbeat',
  TOOL_EVENT: 'tool_event',
  TOOL_DONE: 'tool_done',
  TOOL_ERROR: 'tool_error',
  SESSION_CREATED: 'session_created',
  STATUS_RESPONSE: 'status_response',
} as const;

export {
  validateGatewayUplinkBusinessMessage,
  TOOL_ERROR_REASONS,
  TRANSPORT_UPSTREAM_MESSAGE_TYPES,
} from '@agent-plugin/gateway-schema';

export type {
  GatewayUplinkBusinessMessage as UpstreamMessage,
  ToolErrorReason,
  RegisterMessage,
  HeartbeatMessage,
  ToolEventMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  SessionCreatedMessage,
  StatusResponseMessage,
} from '@agent-plugin/gateway-schema';

export const isUpstreamMessage = (message: unknown): message is GatewayUplinkBusinessMessage =>
  validateGatewayUplinkBusinessMessage(message).ok;
