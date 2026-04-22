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

export const OPENCODE_TOOL_EVENT_TYPES = [
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
  'permission.replied',
  'question.asked',
] as const;

/**
 * 历史别名：保留给现有 opencode 侧调用方，语义等价于 OPENCODE_TOOL_EVENT_TYPES。
 */
export const TOOL_EVENT_TYPES = OPENCODE_TOOL_EVENT_TYPES;

export const SKILL_PROVIDER_EVENT_TYPES = [
  'text.delta',
  'text.done',
  'thinking.delta',
  'thinking.done',
  'tool.update',
  'question',
  'permission.ask',
  'permission.reply',
  'step.start',
  'step.done',
  'session.status',
  'session.error',
] as const;

export const SUPPORTED_TOOL_EVENT_TYPES = [
  ...OPENCODE_TOOL_EVENT_TYPES,
  'text.delta',
  'text.done',
  'thinking.delta',
  'thinking.done',
  'tool.update',
  'question',
  'permission.ask',
  'permission.reply',
  'step.start',
  'step.done',
] as const;

export type OpencodeToolEventType = (typeof OPENCODE_TOOL_EVENT_TYPES)[number];
export type SkillProviderEventType = (typeof SKILL_PROVIDER_EVENT_TYPES)[number];
export type SupportedToolEventType = (typeof SUPPORTED_TOOL_EVENT_TYPES)[number];
