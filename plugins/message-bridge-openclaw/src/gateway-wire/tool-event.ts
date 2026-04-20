import {
  MESSAGE_PART_DELTA_FIELDS,
  MESSAGE_PART_STATE_STATUSES,
  MESSAGE_PART_TYPES,
  SESSION_STATUS_TYPES,
  TOOL_EVENT_TYPES,
  validateToolEvent,
} from "@agent-plugin/gateway-schema";

export { TOOL_EVENT_TYPES, validateToolEvent } from "@agent-plugin/gateway-schema";

export const TOOL_EVENT_TYPE = {
  MESSAGE_UPDATED: TOOL_EVENT_TYPES[0],
  MESSAGE_PART_UPDATED: TOOL_EVENT_TYPES[1],
  MESSAGE_PART_DELTA: TOOL_EVENT_TYPES[2],
  MESSAGE_PART_REMOVED: TOOL_EVENT_TYPES[3],
  SESSION_STATUS: TOOL_EVENT_TYPES[4],
  SESSION_IDLE: TOOL_EVENT_TYPES[5],
  SESSION_UPDATED: TOOL_EVENT_TYPES[6],
  SESSION_ERROR: TOOL_EVENT_TYPES[7],
  PERMISSION_UPDATED: TOOL_EVENT_TYPES[8],
  PERMISSION_ASKED: TOOL_EVENT_TYPES[9],
  QUESTION_ASKED: TOOL_EVENT_TYPES[10],
} as const;

export const MESSAGE_PART_TYPE = {
  TEXT: MESSAGE_PART_TYPES[0],
  TOOL: MESSAGE_PART_TYPES[1],
} as const;

export const MESSAGE_PART_FIELD = {
  TEXT: MESSAGE_PART_DELTA_FIELDS[0],
} as const;

export const TOOL_PART_STATUS = {
  RUNNING: MESSAGE_PART_STATE_STATUSES[0],
  COMPLETED: MESSAGE_PART_STATE_STATUSES[1],
  ERROR: MESSAGE_PART_STATE_STATUSES[2],
} as const;

export const SESSION_STATUS_TYPE = {
  BUSY: SESSION_STATUS_TYPES[0],
} as const;

export type {
  GatewayToolEventPayload as GatewayToolEvent,
  MessageUpdatedEvent as GatewayMessageUpdatedEvent,
  MessageUpdatedSummaryDiff as GatewayMessageSummaryDiff,
  MessageUpdatedSummary as GatewayMessageSummary,
  MessagePartUpdatedEvent as GatewayMessagePartUpdatedEvent,
  MessagePartDeltaEvent as GatewayMessagePartDeltaEvent,
  MessagePartRemovedEvent as GatewayMessagePartRemovedEvent,
  SessionStatusEvent as GatewaySessionStatusEvent,
  SessionIdleEvent as GatewaySessionIdleEvent,
  SessionUpdatedEvent as GatewaySessionUpdatedEvent,
  SessionErrorEvent as GatewaySessionErrorEvent,
  PermissionUpdatedEvent as GatewayPermissionUpdatedEvent,
  PermissionAskedEvent as GatewayPermissionAskedEvent,
  QuestionAskedEvent as GatewayQuestionAskedEvent,
  SupportedToolEventType as GatewayToolEventType,
} from "@agent-plugin/gateway-schema";
