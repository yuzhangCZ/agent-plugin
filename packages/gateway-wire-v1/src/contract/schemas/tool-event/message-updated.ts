import { z } from 'zod';
import { MESSAGE_ROLES } from '../../literals/tool-event.ts';
import { optionalLooseTrimmedString, requiredTrimmedString } from '../shared.ts';

export const messageUpdatedModelSchema = z
  .object({
    provider: requiredTrimmedString.optional(),
    name: requiredTrimmedString.optional(),
    thinkLevel: requiredTrimmedString.optional(),
  })
  .transform((model) => ({
    ...(model.provider ? { provider: model.provider } : {}),
    ...(model.name ? { name: model.name } : {}),
    ...(model.thinkLevel ? { thinkLevel: model.thinkLevel } : {}),
  }));
export type MessageUpdatedModelV1 = z.output<typeof messageUpdatedModelSchema>;

export const messageUpdatedSummaryDiffSchema = z
  .object({
    file: requiredTrimmedString.optional(),
    status: requiredTrimmedString.optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
  })
  .transform((diff) => ({
    ...(diff.file ? { file: diff.file } : {}),
    ...(diff.status ? { status: diff.status } : {}),
    ...(diff.additions !== undefined ? { additions: diff.additions } : {}),
    ...(diff.deletions !== undefined ? { deletions: diff.deletions } : {}),
  }));
export type MessageUpdatedSummaryDiffV1 = z.output<typeof messageUpdatedSummaryDiffSchema>;

export const messageUpdatedSummarySchema = z
  .object({
    additions: z.number().optional(),
    deletions: z.number().optional(),
    files: z.number().optional(),
    diffs: z.array(messageUpdatedSummaryDiffSchema).optional(),
  })
  .transform((summary) => ({
    ...(summary.additions !== undefined ? { additions: summary.additions } : {}),
    ...(summary.deletions !== undefined ? { deletions: summary.deletions } : {}),
    ...(summary.files !== undefined ? { files: summary.files } : {}),
    ...(summary.diffs && summary.diffs.length > 0 ? { diffs: summary.diffs } : {}),
  }));
export type MessageUpdatedSummaryV1 = z.output<typeof messageUpdatedSummarySchema>;

export const messageUpdatedTimeSchema = z.object({
  created: z.number(),
  updated: z.number().optional(),
});
export type MessageUpdatedTimeV1 = z.output<typeof messageUpdatedTimeSchema>;

export const messageUpdatedFinishSchema = z
  .object({
    reason: optionalLooseTrimmedString,
  })
  .transform((finish) => (finish.reason ? { reason: finish.reason } : undefined));
export type MessageUpdatedFinishV1 = NonNullable<z.output<typeof messageUpdatedFinishSchema>>;

export const messageUpdatedInfoSchema = z
  .object({
    id: requiredTrimmedString,
    sessionID: requiredTrimmedString,
    role: z.enum(MESSAGE_ROLES),
    time: messageUpdatedTimeSchema,
    model: messageUpdatedModelSchema.optional(),
    summary: messageUpdatedSummarySchema.optional(),
    finish: messageUpdatedFinishSchema.optional(),
  })
  .transform((info) => ({
    id: info.id,
    sessionID: info.sessionID,
    role: info.role,
    time: {
      created: info.time.created,
      ...(info.time.updated !== undefined ? { updated: info.time.updated } : {}),
    },
    ...(info.model && Object.keys(info.model).length > 0 ? { model: info.model } : {}),
    ...(info.summary && Object.keys(info.summary).length > 0 ? { summary: info.summary } : {}),
    ...(info.finish ? { finish: info.finish } : {}),
  }));
export type MessageUpdatedInfoV1 = z.output<typeof messageUpdatedInfoSchema>;

const messageUpdatedInputInfoSchema = z.object({
  id: optionalLooseTrimmedString,
  sessionID: optionalLooseTrimmedString,
  role: z.enum(MESSAGE_ROLES),
  time: messageUpdatedTimeSchema,
  model: messageUpdatedModelSchema.optional(),
  summary: messageUpdatedSummarySchema.optional(),
  finish: messageUpdatedFinishSchema.optional(),
});

export const messageUpdatedEventSchema = z
  .object({
    type: z.literal('message.updated'),
    properties: z.object({
      sessionID: optionalLooseTrimmedString,
      messageID: optionalLooseTrimmedString,
      info: messageUpdatedInputInfoSchema,
    }),
  })
  .transform((event, ctx) => {
    const id = event.properties.info.id ?? event.properties.messageID;
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['properties', 'info', 'id'],
        message: 'Required',
      });
      return z.NEVER;
    }

    const sessionID = event.properties.info.sessionID ?? event.properties.sessionID;
    if (!sessionID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['properties', 'info', 'sessionID'],
        message: 'Required',
      });
      return z.NEVER;
    }

    return {
      type: 'message.updated' as const,
      properties: {
        info: {
          id,
          sessionID,
          role: event.properties.info.role,
          time: event.properties.info.time,
          ...(event.properties.info.model && Object.keys(event.properties.info.model).length > 0
            ? { model: event.properties.info.model }
            : {}),
          ...(event.properties.info.summary && Object.keys(event.properties.info.summary).length > 0
            ? { summary: event.properties.info.summary }
            : {}),
          ...(event.properties.info.finish ? { finish: event.properties.info.finish } : {}),
        },
      },
    };
  });
export type MessageUpdatedEventV1 = z.output<typeof messageUpdatedEventSchema>;
