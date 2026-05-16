import { z } from 'zod';

import { withCloudProtocol } from '../shared-protocol.ts';
import { requiredTrimmedString } from '../../shared.ts';
import { SESSION_STATUS_TYPES } from '../../../literals/tool-event.ts';

const skillSessionStatusEventBaseSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({
    sessionStatus: z.enum(SESSION_STATUS_TYPES),
  }),
});

export const skillSessionStatusEventSchema = withCloudProtocol(skillSessionStatusEventBaseSchema);
export type SkillSessionStatusEvent = z.output<typeof skillSessionStatusEventSchema>;

const skillSessionTitleEventBaseSchema = z.object({
  type: z.literal('session.title'),
  properties: z.object({
    title: requiredTrimmedString,
  }),
});

export const skillSessionTitleEventSchema = withCloudProtocol(skillSessionTitleEventBaseSchema);
export type SkillSessionTitleEvent = z.output<typeof skillSessionTitleEventSchema>;

const skillSessionErrorEventBaseSchema = z.object({
  type: z.literal('session.error'),
  properties: z.object({
    error: requiredTrimmedString,
  }),
});

export const skillSessionErrorEventSchema = withCloudProtocol(skillSessionErrorEventBaseSchema);
export type SkillSessionErrorEvent = z.output<typeof skillSessionErrorEventSchema>;
