import { z } from 'zod';

import { requiredTrimmedString } from '../../shared.ts';
import { withCloudProtocol } from '../shared-protocol.ts';

export const skillQuestionOptionSchema = z.object({
  label: requiredTrimmedString,
});

export const skillQuestionItemSchema = z.object({
  question: requiredTrimmedString,
  header: requiredTrimmedString.optional(),
  options: z.array(skillQuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
});

const skillQuestionLegacyRejectedFields = ['question', 'header', 'options', 'multiSelect'] as const;

const skillQuestionEventPropertiesSchema = z
  .object({
    messageId: requiredTrimmedString,
    partId: requiredTrimmedString,
    toolCallId: requiredTrimmedString.optional(),
    status: requiredTrimmedString.optional(),
    extParam: z.unknown().optional(),
    questions: z.array(skillQuestionItemSchema).min(1),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const field of skillQuestionLegacyRejectedFields) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is not supported in cloud question properties`,
        });
      }
    }
  })
  .transform(({ messageId, partId, toolCallId, status, extParam, questions }) => ({
    messageId,
    partId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(status === undefined ? {} : { status }),
    ...(extParam === undefined ? {} : { extParam }),
    questions,
  }));

const skillQuestionEventBaseSchema = z.object({
  type: z.literal('question'),
  properties: skillQuestionEventPropertiesSchema,
});

export const skillQuestionEventSchema = withCloudProtocol(skillQuestionEventBaseSchema);
export type SkillQuestionEvent = z.output<typeof skillQuestionEventSchema>;
