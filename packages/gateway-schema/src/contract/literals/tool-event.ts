export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_PART_TYPES = ['text', 'tool', 'reasoning', 'step-start', 'step-finish', 'file'] as const;
export type MessagePartType = (typeof MESSAGE_PART_TYPES)[number];

export const MESSAGE_PART_STATE_STATUSES = ['running', 'completed', 'error', 'pending'] as const;
export type MessagePartStateStatus = (typeof MESSAGE_PART_STATE_STATUSES)[number];

export const MESSAGE_PART_DELTA_FIELDS = ['text'] as const;
export type MessagePartDeltaField = (typeof MESSAGE_PART_DELTA_FIELDS)[number];

export const SESSION_STATUS_TYPES = ['busy', 'idle'] as const;
export type SessionStatusType = (typeof SESSION_STATUS_TYPES)[number];

export const TOOL_EVENT_TYPES = [
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'session.status',
  'session.idle',
  'session.updated',
  'session.error',
  'permission.updated',
  'permission.asked',
  'question.asked',
] as const;

export const SUPPORTED_TOOL_EVENT_TYPES = TOOL_EVENT_TYPES;
export type SupportedToolEventType = (typeof TOOL_EVENT_TYPES)[number];
