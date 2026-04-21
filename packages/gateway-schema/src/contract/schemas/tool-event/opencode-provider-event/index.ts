import { z } from 'zod';

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
  permissionRepliedEventSchema,
  permissionUpdatedEventSchema,
  type PermissionAskedEventV1,
  type PermissionRepliedEventV1,
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

/**
 * 当前态 `tool_event.event` 的唯一共享来源。
 * @remarks 它承接已落地的 legacy/current-state event family，不代表目标态统一事件来源已落地。
 */
export const opencodeProviderEventSchema = z.discriminatedUnion('type', [
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
  permissionRepliedEventSchema,
  questionAskedEventSchema,
]);

export type OpencodeProviderEvent = z.output<typeof opencodeProviderEventSchema>;

export type MessageUpdatedEvent = MessageUpdatedEventV1;
export type MessageUpdatedInfo = MessageUpdatedInfoV1;
export type MessageUpdatedModel = MessageUpdatedModelV1;
export type MessageUpdatedSummaryDiff = MessageUpdatedSummaryDiffV1;
export type MessageUpdatedSummary = MessageUpdatedSummaryV1;
export type MessageUpdatedTime = MessageUpdatedTimeV1;
export type MessagePartText = MessagePartTextV1;
export type MessagePartToolState = MessagePartToolStateV1;
export type MessagePartTool = MessagePartToolV1;
export type MessagePartUpdatedEvent = MessagePartUpdatedEventV1;
export type MessagePartDeltaEvent = MessagePartDeltaEventV1;
export type MessagePartRemovedEvent = MessagePartRemovedEventV1;
export type MessagePart = MessagePartV1;
export type SessionStatusEvent = SessionStatusEventV1;
export type SessionIdleEvent = SessionIdleEventV1;
export type SessionUpdatedEvent = SessionUpdatedEventV1;
export type SessionErrorEvent = SessionErrorEventV1;
export type PermissionUpdatedEvent = PermissionUpdatedEventV1;
export type PermissionAskedEvent = PermissionAskedEventV1;
export type PermissionRepliedEvent = PermissionRepliedEventV1;
export type QuestionAskedOption = QuestionAskedOptionV1;
export type QuestionAskedItem = QuestionAskedItemV1;
export type QuestionAskedToolRef = QuestionAskedToolRefV1;
export type QuestionAskedEvent = QuestionAskedEventV1;

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
  permissionRepliedEventSchema,
  questionAskedEventSchema,
  messagePartSchema,
  messagePartTextSchema,
  messagePartToolSchema,
  messagePartToolStateSchema,
  questionAskedOptionSchema,
  questionAskedItemSchema,
  questionAskedToolRefSchema,
};
