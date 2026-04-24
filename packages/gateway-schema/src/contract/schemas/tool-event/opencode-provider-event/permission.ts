import { z } from 'zod';
import { jsonValueSchema } from './json.ts';
import { optionalLooseTrimmedString, requiredTrimmedString } from '../../shared.ts';

const permissionMetadataSchema = z
  .preprocess(
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
      }

      return value;
    },
    z.record(z.string(), jsonValueSchema).optional(),
  )
  .optional()
  .transform((metadata) => (metadata && Object.keys(metadata).length > 0 ? metadata : undefined));

const permissionStatusSchema = z
  .union([
    z.string(),
    z.object({
      type: z.string(),
    }),
  ])
  .optional()
  .transform((status) => {
    if (!status) {
      return undefined;
    }

    const raw = typeof status === 'string' ? status : status.type;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : undefined;
  });

const permissionResolvedSchema = z
  .object({
    resolved: z.boolean().optional(),
    isResolved: z.boolean().optional(),
  })
  .passthrough()
  .transform((result) => result.resolved ?? result.isResolved);

export const permissionUpdatedEventSchema = z
  .object({
    type: z.literal('permission.updated'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      id: optionalLooseTrimmedString,
      permissionID: optionalLooseTrimmedString,
      messageID: optionalLooseTrimmedString,
      type: optionalLooseTrimmedString,
      permission: optionalLooseTrimmedString,
      title: optionalLooseTrimmedString,
      metadata: permissionMetadataSchema,
      status: permissionStatusSchema,
      response: optionalLooseTrimmedString,
      decision: optionalLooseTrimmedString,
      answer: optionalLooseTrimmedString,
      resolved: z.boolean().optional(),
      isResolved: z.boolean().optional(),
      result: permissionResolvedSchema.optional(),
    }),
  })
  .transform((event) => {
    const id = event.properties.id ?? event.properties.permissionID;
    const type = event.properties.type ?? event.properties.permission;
    const response = event.properties.response ?? event.properties.decision ?? event.properties.answer;
    const resolved = event.properties.resolved ?? event.properties.isResolved ?? event.properties.result;

    return {
      type: 'permission.updated' as const,
      properties: {
        sessionID: event.properties.sessionID,
        ...(id ? { id } : {}),
        ...(event.properties.messageID ? { messageID: event.properties.messageID } : {}),
        ...(type ? { type } : {}),
        ...(event.properties.title ? { title: event.properties.title } : {}),
        ...(event.properties.metadata ? { metadata: event.properties.metadata } : {}),
        ...(event.properties.status ? { status: event.properties.status } : {}),
        ...(response ? { response } : {}),
        ...(resolved !== undefined ? { resolved } : {}),
      },
    };
  });
export type PermissionUpdatedEventV1 = z.output<typeof permissionUpdatedEventSchema>;

export const permissionAskedEventSchema = z
  .object({
    type: z.literal('permission.asked'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      id: optionalLooseTrimmedString,
      messageID: optionalLooseTrimmedString,
      type: optionalLooseTrimmedString,
      permission: optionalLooseTrimmedString,
      title: optionalLooseTrimmedString,
      metadata: permissionMetadataSchema,
      status: permissionStatusSchema,
      response: optionalLooseTrimmedString,
      decision: optionalLooseTrimmedString,
      answer: optionalLooseTrimmedString,
      resolved: z.boolean().optional(),
      isResolved: z.boolean().optional(),
      result: permissionResolvedSchema.optional(),
    }),
  })
  .transform((event) => {
    const type = event.properties.type ?? event.properties.permission;
    const response = event.properties.response ?? event.properties.decision ?? event.properties.answer;
    const resolved = event.properties.resolved ?? event.properties.isResolved ?? event.properties.result;

    return {
      type: 'permission.asked' as const,
      properties: {
        sessionID: event.properties.sessionID,
        ...(event.properties.id ? { id: event.properties.id } : {}),
        ...(event.properties.messageID ? { messageID: event.properties.messageID } : {}),
        ...(type ? { type } : {}),
        ...(event.properties.title ? { title: event.properties.title } : {}),
        ...(event.properties.metadata ? { metadata: event.properties.metadata } : {}),
        ...(event.properties.status ? { status: event.properties.status } : {}),
        ...(response ? { response } : {}),
        ...(resolved !== undefined ? { resolved } : {}),
      },
    };
  });
export type PermissionAskedEventV1 = z.output<typeof permissionAskedEventSchema>;

export const permissionRepliedEventSchema = z
  .object({
    type: z.literal('permission.replied'),
    properties: z.object({
      sessionID: requiredTrimmedString,
      requestID: requiredTrimmedString,
      reply: z.enum(['once', 'always', 'reject']),
    }),
  })
  .transform((event) => ({
    type: 'permission.replied' as const,
    properties: {
      sessionID: event.properties.sessionID,
      requestID: event.properties.requestID,
      reply: event.properties.reply,
    },
  }));
export type PermissionRepliedEventV1 = z.output<typeof permissionRepliedEventSchema>;
