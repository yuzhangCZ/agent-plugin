import { z } from 'zod';
import { MESSAGE_PART_DELTA_FIELDS } from '../../../literals/tool-event.ts';
import { requiredLooseTrimmedStringPreservingEmpty, requiredTrimmedString } from '../../shared.ts';

export const messagePartDeltaEventSchema = z
  .object({
    type: z.literal('message.part.delta'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      messageID: requiredTrimmedString,
      partID: requiredTrimmedString,
      field: z.enum(MESSAGE_PART_DELTA_FIELDS),
      delta: requiredLooseTrimmedStringPreservingEmpty,
    }),
  })
  .transform((event) => ({
    type: 'message.part.delta' as const,
    properties: {
      sessionID: event.properties.sessionID,
      messageID: event.properties.messageID,
      partID: event.properties.partID,
      field: event.properties.field,
      delta: event.properties.delta,
    },
  }));
export type MessagePartDeltaEventV1 = z.output<typeof messagePartDeltaEventSchema>;

export const messagePartRemovedEventSchema = z
  .object({
    type: z.literal('message.part.removed'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      messageID: requiredTrimmedString,
      partID: requiredTrimmedString,
    }),
  })
  .transform((event) => ({
    type: 'message.part.removed' as const,
    properties: {
      sessionID: event.properties.sessionID,
      messageID: event.properties.messageID,
      partID: event.properties.partID,
    },
  }));
export type MessagePartRemovedEventV1 = z.output<typeof messagePartRemovedEventSchema>;
