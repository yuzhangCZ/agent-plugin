export const UPSTREAM_MESSAGE_TYPES = [
  'register',
  'register_ok',
  'register_rejected',
  'heartbeat',
  'tool_event',
  'tool_done',
  'tool_error',
  'session_created',
  'status_response',
] as const;

export const TRANSPORT_UPSTREAM_MESSAGE_TYPES = UPSTREAM_MESSAGE_TYPES;
export type UpstreamMessageType = (typeof UPSTREAM_MESSAGE_TYPES)[number];

export const TOOL_ERROR_REASONS = ['session_not_found'] as const;
export type ToolErrorReason = (typeof TOOL_ERROR_REASONS)[number];
