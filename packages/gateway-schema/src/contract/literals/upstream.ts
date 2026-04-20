export const REGISTER_MESSAGE_TYPE = 'register' as const;
export const REGISTER_OK_MESSAGE_TYPE = 'register_ok' as const;
export const REGISTER_REJECTED_MESSAGE_TYPE = 'register_rejected' as const;
export const HEARTBEAT_MESSAGE_TYPE = 'heartbeat' as const;
export const TOOL_EVENT_MESSAGE_TYPE = 'tool_event' as const;
export const TOOL_DONE_MESSAGE_TYPE = 'tool_done' as const;
export const TOOL_ERROR_MESSAGE_TYPE = 'tool_error' as const;
export const SESSION_CREATED_MESSAGE_TYPE = 'session_created' as const;
export const STATUS_RESPONSE_MESSAGE_TYPE = 'status_response' as const;

export const UPSTREAM_MESSAGE_TYPES = [
  REGISTER_MESSAGE_TYPE,
  REGISTER_OK_MESSAGE_TYPE,
  REGISTER_REJECTED_MESSAGE_TYPE,
  HEARTBEAT_MESSAGE_TYPE,
  TOOL_EVENT_MESSAGE_TYPE,
  TOOL_DONE_MESSAGE_TYPE,
  TOOL_ERROR_MESSAGE_TYPE,
  SESSION_CREATED_MESSAGE_TYPE,
  STATUS_RESPONSE_MESSAGE_TYPE,
] as const;

export const TRANSPORT_UPSTREAM_MESSAGE_TYPES = UPSTREAM_MESSAGE_TYPES;
export type UpstreamMessageType = (typeof UPSTREAM_MESSAGE_TYPES)[number];

export const TOOL_ERROR_REASONS = ['session_not_found'] as const;
export type ToolErrorReason = (typeof TOOL_ERROR_REASONS)[number];
