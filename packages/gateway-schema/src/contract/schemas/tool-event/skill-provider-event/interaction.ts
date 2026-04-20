import { z } from 'zod';

import { requiredTrimmedString } from '../../shared.ts';
import { withToolEventFamily } from '../shared-family.ts';

export const skillQuestionOptionSchema = requiredTrimmedString;

const skillQuestionEventBaseSchema = z.object({
  type: z.literal('question'),
  properties: z.object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    question: requiredTrimmedString,
    toolName: requiredTrimmedString.optional(),
    toolCallId: requiredTrimmedString.optional(),
    status: requiredTrimmedString.optional(),
    header: requiredTrimmedString.optional(),
    options: z.array(skillQuestionOptionSchema).optional(),
  }),
});

export const skillQuestionEventSchema = withToolEventFamily('skill', skillQuestionEventBaseSchema);
export type SkillQuestionEvent = z.output<typeof skillQuestionEventSchema>;
