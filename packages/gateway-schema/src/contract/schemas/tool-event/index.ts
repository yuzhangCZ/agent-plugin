import { z } from 'zod';

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

/**
 * 当前态 `tool_event.event` opencode provider payload。
 * @remarks 缺失 `protocol` 时按 opencode canonical shape 判定，不在 payload 内补充额外 discriminator。
 */
export const opencodeProviderEventSchema = z.union([
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
export type GatewayToolEventPayload = OpencodeProviderEvent | SkillProviderEvent;
export type GatewayToolEventProviderKind = 'cloud' | 'opencode';
type GatewayToolEventEnvelope =
  | { __providerKind: 'cloud'; value: unknown }
  | { __providerKind: 'opencode'; value: unknown }
  | { __providerKind: 'invalid'; value: unknown };

function hasOwnProtocolField(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, 'protocol');
}

/**
 * `tool_event.event` provider dispatch 的唯一判定入口。
 * @remarks current-state 只识别 `protocol: "cloud"`；缺失 `protocol` 视为 opencode；
 * 任意其它显式 `protocol` 一律 fail-closed，且 cloud 分支不允许回退到 opencode。
 */
export function selectGatewayToolEventProviderKind(raw: unknown): GatewayToolEventProviderKind | null {
  if (hasOwnProtocolField(raw)) {
    return raw.protocol === 'cloud' ? 'cloud' : null;
  }

  return 'opencode';
}

function wrapGatewayToolEventPayload(raw: unknown): GatewayToolEventEnvelope {
  const providerKind = selectGatewayToolEventProviderKind(raw);
  if (providerKind === null) {
    return {
      __providerKind: 'invalid',
      value: raw,
    };
  }

  return {
    __providerKind: providerKind,
    value: raw,
  };
}

const invalidGatewayToolEventEnvelopeSchema = z
  .object({
    __providerKind: z.literal('invalid'),
    value: z.unknown(),
  })
  .superRefine((_, ctx) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protocol'],
      message: 'protocol must be "cloud" or absent',
    });
  });

/**
 * 当前态 `tool_event.event` canonical payload union。
 * @remarks `protocol: "cloud"` 表示 cloud/skill provider event；
 * 缺失 `protocol` 表示 opencode provider event。
 */
export const gatewayToolEventPayloadSchema: z.ZodType<GatewayToolEventPayload> = z
  .preprocess(
    wrapGatewayToolEventPayload,
    z
      .discriminatedUnion('__providerKind', [
        z.object({
          __providerKind: z.literal('cloud'),
          value: skillProviderEventSchema,
        }),
        z.object({
          __providerKind: z.literal('opencode'),
          value: opencodeProviderEventSchema,
        }),
        invalidGatewayToolEventEnvelopeSchema,
      ])
      .transform((envelope) => envelope.value as GatewayToolEventPayload),
  );

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
