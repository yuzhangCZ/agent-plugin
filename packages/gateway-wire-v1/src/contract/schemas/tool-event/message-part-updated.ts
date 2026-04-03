import { z } from 'zod';
import {
  MESSAGE_PART_STATE_STATUSES,
} from '../../literals/tool-event.ts';
import { jsonValueSchema } from './json.ts';
import { optionalLooseTrimmedString, requiredTrimmedString } from '../shared.ts';

export const messagePartToolStateSchema = z
  .object({
    status: z.enum(MESSAGE_PART_STATE_STATUSES),
    output: jsonValueSchema.optional(),
    error: optionalLooseTrimmedString,
    title: optionalLooseTrimmedString,
  })
  .transform((state) => ({
    status: state.status,
    ...(state.output !== undefined ? { output: state.output } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.title ? { title: state.title } : {}),
  }));
export type MessagePartToolStateV1 = z.output<typeof messagePartToolStateSchema>;

const messagePartBaseSchema = {
  id: requiredTrimmedString,
  sessionID: requiredTrimmedString,
  messageID: requiredTrimmedString,
} as const;

export const messagePartTextSchema = z
  .object({
    ...messagePartBaseSchema,
    type: z.literal('text'),
    text: requiredTrimmedString,
  })
  .transform((part) => ({
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'text' as const,
    text: part.text,
  }));
export type MessagePartTextV1 = z.output<typeof messagePartTextSchema>;

export const messagePartReasoningSchema = z
  .object({
    ...messagePartBaseSchema,
    type: z.literal('reasoning'),
    text: requiredTrimmedString,
  })
  .transform((part) => ({
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'reasoning' as const,
    text: part.text,
  }));
export type MessagePartReasoningV1 = z.output<typeof messagePartReasoningSchema>;

export const messagePartToolSchema = z
  .object({
    ...messagePartBaseSchema,
    type: z.literal('tool'),
    tool: requiredTrimmedString,
    callID: requiredTrimmedString,
    state: messagePartToolStateSchema.optional(),
  })
  .transform((part) => ({
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'tool' as const,
    tool: part.tool,
    callID: part.callID,
    ...(part.state ? { state: part.state } : {}),
  }));
export type MessagePartToolV1 = z.output<typeof messagePartToolSchema>;

export const messagePartStepStartSchema = z.object({
  ...messagePartBaseSchema,
  type: z.literal('step-start'),
});
export type MessagePartStepStartV1 = z.output<typeof messagePartStepStartSchema>;

export const messagePartStepFinishSchema = z
  .object({
    ...messagePartBaseSchema,
    type: z.literal('step-finish'),
    tokens: jsonValueSchema.optional(),
    cost: z.number().optional(),
    reason: optionalLooseTrimmedString,
  })
  .transform((part) => ({
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'step-finish' as const,
    ...(part.tokens !== undefined ? { tokens: part.tokens } : {}),
    ...(part.cost !== undefined ? { cost: part.cost } : {}),
    ...(part.reason ? { reason: part.reason } : {}),
  }));
export type MessagePartStepFinishV1 = z.output<typeof messagePartStepFinishSchema>;

export const messagePartFileSchema = z
  .object({
    ...messagePartBaseSchema,
    type: z.literal('file'),
    filename: optionalLooseTrimmedString,
    url: optionalLooseTrimmedString,
    mime: optionalLooseTrimmedString,
  })
  .transform((part) => ({
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'file' as const,
    ...(part.filename ? { filename: part.filename } : {}),
    ...(part.url ? { url: part.url } : {}),
    ...(part.mime ? { mime: part.mime } : {}),
  }));
export type MessagePartFileV1 = z.output<typeof messagePartFileSchema>;

export const messagePartSchema = z.discriminatedUnion('type', [
  messagePartTextSchema,
  messagePartToolSchema,
  messagePartReasoningSchema,
  messagePartStepStartSchema,
  messagePartStepFinishSchema,
  messagePartFileSchema,
]);
export type MessagePartV1 = z.output<typeof messagePartSchema>;

export const messagePartUpdatedEventSchema = z
  .object({
    type: z.literal('message.part.updated'),
    properties: z.object({
      part: messagePartSchema,
      delta: optionalLooseTrimmedString,
    }),
  })
  .transform((event) => ({
    type: 'message.part.updated' as const,
    properties: {
      part: event.properties.part,
      ...(event.properties.delta ? { delta: event.properties.delta } : {}),
    },
  }));
export type MessagePartUpdatedEventV1 = z.output<typeof messagePartUpdatedEventSchema>;
