import { z } from 'zod';

import { upstreamExtParametersSchema } from '../../ext-parameters.ts';
import { requiredTrimmedString } from '../../shared.ts';
import { withCloudProtocol } from '../shared-protocol.ts';

const skillStepStartEventBaseSchema = z.object({
  type: z.literal('step.start'),
  properties: z.object({
    messageId: requiredTrimmedString,
    extParameters: upstreamExtParametersSchema.optional(),
  }),
});

const skillStepDoneEventBaseSchema = z.object({
  type: z.literal('step.done'),
  properties: z.object({
    messageId: requiredTrimmedString,
    tokens: z.record(z.string(), z.number()).optional(),
    cost: z.number().optional(),
    reason: requiredTrimmedString.optional(),
    extParameters: upstreamExtParametersSchema.optional(),
  }),
});

export const skillStepStartEventSchema = withCloudProtocol(skillStepStartEventBaseSchema);
export const skillStepDoneEventSchema = withCloudProtocol(skillStepDoneEventBaseSchema);

export type SkillStepStartEvent = z.output<typeof skillStepStartEventSchema>;
export type SkillStepDoneEvent = z.output<typeof skillStepDoneEventSchema>;
