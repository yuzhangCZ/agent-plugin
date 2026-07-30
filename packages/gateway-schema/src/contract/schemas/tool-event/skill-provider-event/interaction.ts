import { z } from 'zod';

import { optionalLooseTrimmedStringPreservingEmpty, requiredTrimmedString } from '../../shared.ts';
import { upstreamExtParametersSchema } from '../../ext-parameters.ts';
import { withCloudProtocol } from '../shared-protocol.ts';

export const skillQuestionOptionSchema = z.object({
  label: requiredTrimmedString,
  description: optionalLooseTrimmedStringPreservingEmpty,
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
    questionId: requiredTrimmedString,
    toolCallId: requiredTrimmedString.optional(),
    status: requiredTrimmedString.optional(),
    extParam: z.unknown().optional(),
    extParameters: upstreamExtParametersSchema.optional(),
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
  .transform(({ messageId, partId, questionId, toolCallId, status, extParam, extParameters, questions }) => ({
    messageId,
    partId,
    questionId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(status === undefined ? {} : { status }),
    ...(extParam === undefined ? {} : { extParam }),
    extParameters,
    questions,
  }));

const skillQuestionEventBaseSchema = z.object({
  type: z.literal('question'),
  properties: skillQuestionEventPropertiesSchema,
});

export const skillQuestionEventSchema = withCloudProtocol(skillQuestionEventBaseSchema);
export type SkillQuestionEvent = z.output<typeof skillQuestionEventSchema>;
