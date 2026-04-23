import { z } from 'zod';
import { SESSION_STATUS_TYPES } from '../../../literals/tool-event.ts';
import {
  optionalLooseTrimmedString,
  optionalLooseTrimmedStringPreservingEmpty,
  requiredLooseTrimmedStringPreservingEmpty,
  requiredTrimmedString,
} from '../../shared.ts';

export const sessionStatusEventSchema = z
  .object({
    type: z.literal('session.status'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      status: z.object({
        type: z.enum(SESSION_STATUS_TYPES),
      }),
    }),
  })
  .transform((event) => ({
    type: 'session.status' as const,
    properties: {
      sessionID: event.properties.sessionID,
      status: {
        type: event.properties.status.type,
      },
    },
  }));
export type SessionStatusEventV1 = z.output<typeof sessionStatusEventSchema>;

export const sessionIdleEventSchema = z
  .object({
    type: z.literal('session.idle'),
    properties: z.object({
      sessionID: requiredTrimmedString,
    }),
  })
  .transform((event) => ({
    type: 'session.idle' as const,
    properties: {
      sessionID: event.properties.sessionID,
    },
  }));
export type SessionIdleEventV1 = z.output<typeof sessionIdleEventSchema>;

export const sessionUpdatedEventSchema = z
  .object({
    type: z.literal('session.updated'),
    properties: z.object({
      sessionID: optionalLooseTrimmedString,
      title: optionalLooseTrimmedStringPreservingEmpty,
      info: z.object({
        id: requiredTrimmedString,
        title: optionalLooseTrimmedStringPreservingEmpty,
      }),
    }),
  })
  .transform((event) => ({
    type: 'session.updated' as const,
    properties: {
      sessionID: event.properties.sessionID ?? event.properties.info.id,
      info: {
        id: event.properties.info.id,
        ...(event.properties.info.title !== undefined || event.properties.title !== undefined
          ? { title: event.properties.info.title ?? event.properties.title }
          : {}),
      },
    },
  }));
export type SessionUpdatedEventV1 = z.output<typeof sessionUpdatedEventSchema>;

export const sessionErrorInfoSchema = z.union([
  requiredLooseTrimmedStringPreservingEmpty,
  z.object({
    message: requiredLooseTrimmedStringPreservingEmpty,
  }),
]);

export const sessionErrorEventSchema = z
  .object({
    type: z.literal('session.error'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      error: z
        .preprocess(
          (value) => {
            if (typeof value === 'string') {
              return value;
            }

            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              return undefined;
            }

            return value;
          },
          sessionErrorInfoSchema.optional(),
        )
        .optional(),
    }),
  })
  .transform((event) => ({
    type: 'session.error' as const,
    properties: {
      sessionID: event.properties.sessionID,
      ...(event.properties.error !== undefined
        ? {
            error:
              typeof event.properties.error === 'string'
                ? event.properties.error
                : event.properties.error.message,
          }
        : {}),
    },
  }));
export type SessionErrorEventV1 = z.output<typeof sessionErrorEventSchema>;
