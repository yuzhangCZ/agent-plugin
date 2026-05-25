export const GATEWAY_UPLINK_MESSAGE_TYPE = {
  toolEvent: 'tool_event',
  statusResponse: 'status_response',
  sessionCreated: 'session_created',
  toolDone: 'tool_done',
  toolError: 'tool_error',
} as const;

export const SKILL_EVENT_PROTOCOL = {
  cloud: 'cloud',
} as const;
