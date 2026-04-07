import { z } from 'zod';
import { type SupportedToolEventType } from '../../literals/tool-event.ts';
import {
  messageUpdatedEventSchema,
  type MessageUpdatedEventV1,
  type MessageUpdatedInfoV1,
  type MessageUpdatedModelV1,
  type MessageUpdatedSummaryDiffV1,
  type MessageUpdatedSummaryV1,
  type MessageUpdatedTimeV1,
} from './message-updated.ts';
import {
  messagePartDeltaEventSchema,
  messagePartRemovedEventSchema,
  type MessagePartDeltaEventV1,
  type MessagePartRemovedEventV1,
} from './message-part.ts';
import {
  messagePartSchema,
  messagePartTextSchema,
  messagePartToolSchema,
  messagePartToolStateSchema,
  messagePartUpdatedEventSchema,
  type MessagePartTextV1,
  type MessagePartToolStateV1,
  type MessagePartToolV1,
  type MessagePartUpdatedEventV1,
  type MessagePartV1,
} from './message-part-updated.ts';
import {
  permissionAskedEventSchema,
  permissionUpdatedEventSchema,
  type PermissionAskedEventV1,
  type PermissionUpdatedEventV1,
} from './permission.ts';
import {
  questionAskedEventSchema,
  questionAskedItemSchema,
  questionAskedOptionSchema,
  questionAskedToolRefSchema,
  type QuestionAskedEventV1,
  type QuestionAskedItemV1,
  type QuestionAskedOptionV1,
  type QuestionAskedToolRefV1,
} from './question.ts';
import {
  sessionErrorEventSchema,
  sessionIdleEventSchema,
  sessionStatusEventSchema,
  sessionUpdatedEventSchema,
  type SessionErrorEventV1,
  type SessionIdleEventV1,
  type SessionStatusEventV1,
  type SessionUpdatedEventV1,
} from './session.ts';

export const gatewayToolEventSchema = z.discriminatedUnion('type', [
  messageUpdatedEventSchema,
  messagePartUpdatedEventSchema,
  messagePartDeltaEventSchema,
  messagePartRemovedEventSchema,
  sessionStatusEventSchema,
  sessionIdleEventSchema,
  sessionUpdatedEventSchema,
  sessionErrorEventSchema,
  permissionUpdatedEventSchema,
  permissionAskedEventSchema,
  questionAskedEventSchema,
]);

export type GatewayToolEventV1 = z.output<typeof gatewayToolEventSchema>;

export {
  messageUpdatedEventSchema,
  messagePartUpdatedEventSchema,
  messagePartDeltaEventSchema,
  messagePartRemovedEventSchema,
  sessionStatusEventSchema,
  sessionIdleEventSchema,
  sessionUpdatedEventSchema,
  sessionErrorEventSchema,
  permissionUpdatedEventSchema,
  permissionAskedEventSchema,
  questionAskedEventSchema,
  messagePartSchema,
  messagePartTextSchema,
  messagePartToolSchema,
  messagePartToolStateSchema,
  questionAskedOptionSchema,
  questionAskedItemSchema,
  questionAskedToolRefSchema,
};

export type {
  MessageUpdatedEventV1,
  MessageUpdatedInfoV1,
  MessageUpdatedModelV1,
  MessageUpdatedSummaryDiffV1,
  MessageUpdatedSummaryV1,
  MessageUpdatedTimeV1,
  MessagePartTextV1,
  MessagePartToolStateV1,
  MessagePartToolV1,
  MessagePartUpdatedEventV1,
  MessagePartDeltaEventV1,
  MessagePartRemovedEventV1,
  MessagePartV1,
  SessionStatusEventV1,
  SessionIdleEventV1,
  SessionUpdatedEventV1,
  SessionErrorEventV1,
  PermissionUpdatedEventV1,
  PermissionAskedEventV1,
  QuestionAskedOptionV1,
  QuestionAskedItemV1,
  QuestionAskedToolRefV1,
  QuestionAskedEventV1,
};
