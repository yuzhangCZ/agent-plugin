import { z } from 'zod';

import { requiredTrimmedString } from '../../shared.ts';
import { MESSAGE_PART_STATE_STATUSES } from '../../../literals/tool-event.ts';
import { withToolEventFamily } from '../shared-family.ts';

const skillTextDeltaEventBaseSchema = z.object({
  type: z.literal('text.delta'),
  properties: z.object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    content: requiredTrimmedString,
  }),
});

const skillTextDoneEventBaseSchema = z.object({
  type: z.literal('text.done'),
  properties: z.object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    content: requiredTrimmedString,
  }),
});

const skillThinkingDeltaEventBaseSchema = z.object({
  type: z.literal('thinking.delta'),
  properties: z.object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    content: requiredTrimmedString,
  }),
});

const skillThinkingDoneEventBaseSchema = z.object({
  type: z.literal('thinking.done'),
  properties: z.object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    content: requiredTrimmedString,
  }),
});

const skillToolUpdateEventBaseSchema = z.object({
  type: z.literal('tool.update'),
  properties: z.object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    toolName: requiredTrimmedString,
    status: z.enum(MESSAGE_PART_STATE_STATUSES),
    toolCallId: requiredTrimmedString.optional(),
    title: requiredTrimmedString.optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: requiredTrimmedString.optional(),
  }),
});

export const skillTextDeltaEventSchema = withToolEventFamily('skill', skillTextDeltaEventBaseSchema);
export const skillTextDoneEventSchema = withToolEventFamily('skill', skillTextDoneEventBaseSchema);
export const skillThinkingDeltaEventSchema = withToolEventFamily('skill', skillThinkingDeltaEventBaseSchema);
export const skillThinkingDoneEventSchema = withToolEventFamily('skill', skillThinkingDoneEventBaseSchema);
export const skillToolUpdateEventSchema = withToolEventFamily('skill', skillToolUpdateEventBaseSchema);

export type SkillTextDeltaEvent = z.output<typeof skillTextDeltaEventSchema>;
export type SkillTextDoneEvent = z.output<typeof skillTextDoneEventSchema>;
export type SkillThinkingDeltaEvent = z.output<typeof skillThinkingDeltaEventSchema>;
export type SkillThinkingDoneEvent = z.output<typeof skillThinkingDoneEventSchema>;
export type SkillToolUpdateEvent = z.output<typeof skillToolUpdateEventSchema>;
