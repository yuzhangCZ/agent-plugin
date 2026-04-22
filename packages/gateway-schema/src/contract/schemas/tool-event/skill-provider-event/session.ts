import { z } from 'zod';

import { withCloudProtocol } from '../shared-protocol.ts';
import { requiredTrimmedString } from '../../shared.ts';

const skillSessionStatusEventBaseSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({
    sessionStatus: requiredTrimmedString,
    welinkSessionId: requiredTrimmedString.optional(),
  }),
});

export const skillSessionStatusEventSchema = withCloudProtocol(skillSessionStatusEventBaseSchema);
export type SkillSessionStatusEvent = z.output<typeof skillSessionStatusEventSchema>;

const skillSessionErrorEventBaseSchema = z.object({
  type: z.literal('session.error'),
  properties: z.object({
    error: requiredTrimmedString,
    welinkSessionId: requiredTrimmedString.optional(),
  }),
});

export const skillSessionErrorEventSchema = withCloudProtocol(skillSessionErrorEventBaseSchema);
export type SkillSessionErrorEvent = z.output<typeof skillSessionErrorEventSchema>;
