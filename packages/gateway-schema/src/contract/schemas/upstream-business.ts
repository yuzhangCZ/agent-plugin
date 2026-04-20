import { z } from 'zod';

import { createSessionResultDataSchema } from './downstream.ts';
import { gatewayToolEventPayloadSchema } from './tool-event/index.ts';
import { optionalLooseTrimmedString, optionalStrictTrimmedString, requiredTrimmedString } from './shared.ts';
import { TOOL_ERROR_REASONS, TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '../literals/upstream.ts';

const [, , , , TOOL_EVENT_MESSAGE_TYPE, TOOL_DONE_MESSAGE_TYPE, TOOL_ERROR_MESSAGE_TYPE, SESSION_CREATED_MESSAGE_TYPE, STATUS_RESPONSE_MESSAGE_TYPE] =
  TRANSPORT_UPSTREAM_MESSAGE_TYPES;

export const toolUsageSchema = z.object({
  tokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});
export type ToolUsage = z.output<typeof toolUsageSchema>;

export const toolEventMessageSchema = z.object({
  type: z.literal(TOOL_EVENT_MESSAGE_TYPE),
  toolSessionId: requiredTrimmedString,
  event: gatewayToolEventPayloadSchema,
});
export type ToolEventMessage = z.output<typeof toolEventMessageSchema>;

export const toolDoneMessageSchema = z
  .object({
    type: z.literal(TOOL_DONE_MESSAGE_TYPE),
    toolSessionId: requiredTrimmedString,
    welinkSessionId: optionalLooseTrimmedString,
    usage: toolUsageSchema.optional(),
  })
  .transform((message) => ({
    type: message.type,
    toolSessionId: message.toolSessionId,
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
    ...(message.usage && Object.keys(message.usage).length > 0 ? { usage: message.usage } : {}),
  }));
export type ToolDoneMessage = z.output<typeof toolDoneMessageSchema>;

export const toolErrorMessageSchema = z
  .object({
    type: z.literal(TOOL_ERROR_MESSAGE_TYPE),
    welinkSessionId: optionalLooseTrimmedString,
    toolSessionId: optionalLooseTrimmedString,
    error: requiredTrimmedString,
    reason: z.enum(TOOL_ERROR_REASONS).optional(),
  })
  .transform((message) => ({
    type: message.type,
    error: message.error,
    ...(message.welinkSessionId ? { welinkSessionId: message.welinkSessionId } : {}),
    ...(message.toolSessionId ? { toolSessionId: message.toolSessionId } : {}),
    ...(message.reason ? { reason: message.reason } : {}),
  }));
export type ToolErrorMessage = z.output<typeof toolErrorMessageSchema>;

export const sessionCreatedMessageSchema = z
  .object({
    type: z.literal(SESSION_CREATED_MESSAGE_TYPE),
    welinkSessionId: requiredTrimmedString,
    toolSessionId: optionalStrictTrimmedString,
    session: createSessionResultDataSchema.optional(),
  })
  .transform((message) => ({
    type: message.type,
    welinkSessionId: message.welinkSessionId,
    ...(message.toolSessionId ? { toolSessionId: message.toolSessionId } : {}),
    ...(message.session ? { session: message.session } : {}),
  }));
export type SessionCreatedMessage = z.output<typeof sessionCreatedMessageSchema>;

export const statusResponseMessageSchema = z.object({
  type: z.literal(STATUS_RESPONSE_MESSAGE_TYPE),
  opencodeOnline: z.boolean(),
});
export type StatusResponseMessage = z.output<typeof statusResponseMessageSchema>;

export const gatewayUplinkBusinessMessageSchema = z.union([
  toolEventMessageSchema,
  toolDoneMessageSchema,
  toolErrorMessageSchema,
  sessionCreatedMessageSchema,
  statusResponseMessageSchema,
]);
export type GatewayUplinkBusinessMessage = z.output<typeof gatewayUplinkBusinessMessageSchema>;
