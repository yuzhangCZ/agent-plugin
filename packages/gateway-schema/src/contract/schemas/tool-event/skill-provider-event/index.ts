import { z } from 'zod';

import { skillQuestionEventSchema, type SkillQuestionEvent } from './interaction.ts';
import {
  skillPermissionAskEventSchema,
  skillPermissionReplyEventSchema,
  type SkillPermissionAskEvent,
  type SkillPermissionReplyEvent,
} from './permission.ts';
import {
  skillSessionErrorEventSchema,
  skillSessionStatusEventSchema,
  type SkillSessionErrorEvent,
  type SkillSessionStatusEvent,
} from './session.ts';
import {
  skillTextDeltaEventSchema,
  skillTextDoneEventSchema,
  skillThinkingDeltaEventSchema,
  skillThinkingDoneEventSchema,
  skillToolUpdateEventSchema,
  type SkillTextDeltaEvent,
  type SkillTextDoneEvent,
  type SkillThinkingDeltaEvent,
  type SkillThinkingDoneEvent,
  type SkillToolUpdateEvent,
} from './stream.ts';
import {
  skillStepDoneEventSchema,
  skillStepStartEventSchema,
  type SkillStepDoneEvent,
  type SkillStepStartEvent,
} from './step.ts';

/**
 * `SkillProviderEvent` 是当前协议层 cloud/skill provider event 白名单。
 * `protocol: "cloud"` 负责 provider 分流，`type` 负责 cloud provider 内部事件判定。
 */
export const skillProviderEventSchema = z.union([
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
]);

export type SkillProviderEvent = z.output<typeof skillProviderEventSchema>;

export {
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
