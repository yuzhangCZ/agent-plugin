import { z } from 'zod';

import { requiredTrimmedString } from '../../shared.ts';
import { withCloudProtocol } from '../shared-protocol.ts';

const skillStepStartEventBaseSchema = z.object({
  type: z.literal('step.start'),
  properties: z.object({
    messageId: requiredTrimmedString,
  }),
});

const skillStepDoneEventBaseSchema = z.object({
  type: z.literal('step.done'),
  properties: z.object({
    messageId: requiredTrimmedString,
    tokens: z.unknown().optional(),
    cost: z.number().optional(),
    reason: requiredTrimmedString.optional(),
  }),
});

export const skillStepStartEventSchema = withCloudProtocol(skillStepStartEventBaseSchema);
export const skillStepDoneEventSchema = withCloudProtocol(skillStepDoneEventBaseSchema);

export type SkillStepStartEvent = z.output<typeof skillStepStartEventSchema>;
export type SkillStepDoneEvent = z.output<typeof skillStepDoneEventSchema>;
