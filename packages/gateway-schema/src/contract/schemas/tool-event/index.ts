import { z } from 'zod';
import { withToolEventFamily } from './shared-family.ts';

import {
  messagePartDeltaEventSchema,
  messagePartRemovedEventSchema,
  messagePartSchema,
  messagePartTextSchema,
  messagePartToolSchema,
  messagePartToolStateSchema,
  messagePartUpdatedEventSchema,
  messageUpdatedEventSchema,
  permissionAskedEventSchema,
  permissionRepliedEventSchema,
  permissionUpdatedEventSchema,
  questionAskedEventSchema,
  questionAskedItemSchema,
  questionAskedOptionSchema,
  questionAskedToolRefSchema,
  sessionErrorEventSchema,
  sessionIdleEventSchema,
  sessionStatusEventSchema,
  sessionUpdatedEventSchema,
  type MessagePartDeltaEvent,
  type MessagePartRemovedEvent,
  type MessagePartText,
  type MessagePartTool,
  type MessagePartToolState,
  type MessagePartUpdatedEvent,
  type MessagePart,
  type MessageUpdatedEvent,
  type MessageUpdatedInfo,
  type MessageUpdatedModel,
  type MessageUpdatedSummaryDiff,
  type MessageUpdatedSummary,
  type MessageUpdatedTime,
  type PermissionAskedEvent,
  type PermissionRepliedEvent,
  type PermissionUpdatedEvent,
  type QuestionAskedEvent,
  type QuestionAskedItem,
  type QuestionAskedOption,
  type QuestionAskedToolRef,
  type SessionErrorEvent,
  type SessionIdleEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
} from './opencode-provider-event/index.ts';
import {
  skillProviderEventSchema,
  skillPermissionAskEventSchema,
  skillPermissionReplyEventSchema,
  skillQuestionEventSchema,
  skillSessionStatusEventSchema,
  skillSessionErrorEventSchema,
  skillStepDoneEventSchema,
  skillStepStartEventSchema,
  skillTextDeltaEventSchema,
  skillTextDoneEventSchema,
  skillThinkingDeltaEventSchema,
  skillThinkingDoneEventSchema,
  skillToolUpdateEventSchema,
  type SkillPermissionAskEvent,
  type SkillPermissionReplyEvent,
  type SkillProviderEvent,
  type SkillQuestionEvent,
  type SkillSessionErrorEvent,
  type SkillSessionStatusEvent,
  type SkillStepDoneEvent,
  type SkillStepStartEvent,
  type SkillTextDeltaEvent,
  type SkillTextDoneEvent,
  type SkillThinkingDeltaEvent,
  type SkillThinkingDoneEvent,
  type SkillToolUpdateEvent,
} from './skill-provider-event/index.ts';

const opencodeMessageUpdatedEventSchema = withToolEventFamily('opencode', messageUpdatedEventSchema);
const opencodeMessagePartUpdatedEventSchema = withToolEventFamily('opencode', messagePartUpdatedEventSchema);
const opencodeMessagePartDeltaEventSchema = withToolEventFamily('opencode', messagePartDeltaEventSchema);
const opencodeMessagePartRemovedEventSchema = withToolEventFamily('opencode', messagePartRemovedEventSchema);
const opencodeSessionStatusEventSchema = withToolEventFamily('opencode', sessionStatusEventSchema);
const opencodeSessionIdleEventSchema = withToolEventFamily('opencode', sessionIdleEventSchema);
const opencodeSessionUpdatedEventSchema = withToolEventFamily('opencode', sessionUpdatedEventSchema);
const opencodeSessionErrorEventSchema = withToolEventFamily('opencode', sessionErrorEventSchema);
const opencodePermissionUpdatedEventSchema = withToolEventFamily('opencode', permissionUpdatedEventSchema);
const opencodePermissionAskedEventSchema = withToolEventFamily('opencode', permissionAskedEventSchema);
const opencodePermissionRepliedEventSchema = withToolEventFamily('opencode', permissionRepliedEventSchema);
const opencodeQuestionAskedEventSchema = withToolEventFamily('opencode', questionAskedEventSchema);

/**
 * 当前态 `tool_event.event` payload family。
 * @remarks current-state 通过显式 `family` 判定 payload 来源；
 * `opencode` 与 `skill` 共存，但仍共享同一 `tool_event.event` 边界。
 */
export const opencodeProviderEventSchema = z.union([
  opencodeMessageUpdatedEventSchema,
  opencodeMessagePartUpdatedEventSchema,
  opencodeMessagePartDeltaEventSchema,
  opencodeMessagePartRemovedEventSchema,
  opencodeSessionStatusEventSchema,
  opencodeSessionIdleEventSchema,
  opencodeSessionUpdatedEventSchema,
  opencodeSessionErrorEventSchema,
  opencodePermissionUpdatedEventSchema,
  opencodePermissionAskedEventSchema,
  opencodePermissionRepliedEventSchema,
  opencodeQuestionAskedEventSchema,
]);

export const gatewayToolEventPayloadSchema = z.union([
  opencodeProviderEventSchema,
  skillProviderEventSchema,
]);

export type OpencodeProviderEvent = z.output<typeof opencodeProviderEventSchema>;
export type GatewayToolEventPayload = z.output<typeof gatewayToolEventPayloadSchema>;

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
  skillProviderEventSchema,
  skillTextDeltaEventSchema,
  skillTextDoneEventSchema,
  skillThinkingDeltaEventSchema,
  skillThinkingDoneEventSchema,
  skillToolUpdateEventSchema,
  skillQuestionEventSchema,
  skillPermissionAskEventSchema,
  skillPermissionReplyEventSchema,
  skillStepStartEventSchema,
  skillStepDoneEventSchema,
  skillSessionStatusEventSchema,
  skillSessionErrorEventSchema,
};

export type {
  MessageUpdatedEvent,
  MessageUpdatedInfo,
  MessageUpdatedModel,
  MessageUpdatedSummaryDiff,
  MessageUpdatedSummary,
  MessageUpdatedTime,
  MessagePartText,
  MessagePartToolState,
  MessagePartTool,
  MessagePartUpdatedEvent,
  MessagePartDeltaEvent,
  MessagePartRemovedEvent,
  MessagePart,
  SessionStatusEvent,
  SessionIdleEvent,
  SessionUpdatedEvent,
  SessionErrorEvent,
  PermissionUpdatedEvent,
  PermissionAskedEvent,
  PermissionRepliedEvent,
  QuestionAskedOption,
  QuestionAskedItem,
  QuestionAskedToolRef,
  QuestionAskedEvent,
  SkillProviderEvent,
  SkillTextDeltaEvent,
  SkillTextDoneEvent,
  SkillThinkingDeltaEvent,
  SkillThinkingDoneEvent,
  SkillToolUpdateEvent,
  SkillQuestionEvent,
  SkillPermissionAskEvent,
  SkillPermissionReplyEvent,
  SkillStepStartEvent,
  SkillStepDoneEvent,
  SkillSessionStatusEvent,
  SkillSessionErrorEvent,
};
