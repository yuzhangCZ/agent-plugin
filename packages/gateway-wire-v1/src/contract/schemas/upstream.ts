import { z } from 'zod';
import { TOOL_ERROR_REASONS, TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '../literals/upstream.ts';
import { createSessionResultDataSchema } from './downstream.ts';
import { gatewayToolEventSchema } from './tool-event/index.ts';
import { optionalLooseTrimmedString, optionalStrictTrimmedString, requiredTrimmedString } from './shared.ts';

const [
  REGISTER_MESSAGE_TYPE,
  REGISTER_OK_MESSAGE_TYPE,
  REGISTER_REJECTED_MESSAGE_TYPE,
  HEARTBEAT_MESSAGE_TYPE,
  TOOL_EVENT_MESSAGE_TYPE,
  TOOL_DONE_MESSAGE_TYPE,
  TOOL_ERROR_MESSAGE_TYPE,
  SESSION_CREATED_MESSAGE_TYPE,
  STATUS_RESPONSE_MESSAGE_TYPE,
] = TRANSPORT_UPSTREAM_MESSAGE_TYPES;

export const toolUsageSchema = z.object({
  tokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});
export type ToolUsageV1 = z.output<typeof toolUsageSchema>;

export const registerTransportSchema = z
  .object({
    type: z.literal(REGISTER_MESSAGE_TYPE),
    deviceName: requiredTrimmedString,
    macAddress: z.string().optional(),
    os: requiredTrimmedString,
    toolType: requiredTrimmedString,
    toolVersion: requiredTrimmedString,
  })
  .transform((message) => {
    const macAddress = message.macAddress?.trim();
    return {
      type: message.type,
      deviceName: message.deviceName,
      os: message.os,
      toolType: message.toolType,
      toolVersion: message.toolVersion,
      ...(macAddress ? { macAddress } : {}),
    };
  });
export type RegisterMessage = z.output<typeof registerTransportSchema>;

export const registerOkTransportSchema = z.object({
  type: z.literal(REGISTER_OK_MESSAGE_TYPE),
});
export type RegisterOkMessage = z.output<typeof registerOkTransportSchema>;

export const registerRejectedTransportSchema = z
  .object({
    type: z.literal(REGISTER_REJECTED_MESSAGE_TYPE),
    reason: optionalLooseTrimmedString,
  })
  .transform((message) => ({
    type: message.type,
    ...(message.reason ? { reason: message.reason } : {}),
  }));
export type RegisterRejectedMessage = z.output<typeof registerRejectedTransportSchema>;

export const heartbeatTransportSchema = z.object({
  type: z.literal(HEARTBEAT_MESSAGE_TYPE),
  timestamp: requiredTrimmedString,
});
export type HeartbeatMessage = z.output<typeof heartbeatTransportSchema>;

export const toolEventTransportSchema = z.object({
  type: z.literal(TOOL_EVENT_MESSAGE_TYPE),
  toolSessionId: requiredTrimmedString,
  event: gatewayToolEventSchema,
});
export type ToolEventMessage = z.output<typeof toolEventTransportSchema>;

export const toolDoneTransportSchema = z
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
export type ToolDoneMessage = z.output<typeof toolDoneTransportSchema>;

export const toolErrorTransportSchema = z
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
export type ToolErrorMessage = z.output<typeof toolErrorTransportSchema>;

export const sessionCreatedTransportSchema = z
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
export type SessionCreatedMessage = z.output<typeof sessionCreatedTransportSchema>;

export const statusResponseTransportSchema = z.object({
  type: z.literal(STATUS_RESPONSE_MESSAGE_TYPE),
  opencodeOnline: z.boolean(),
});
export type StatusResponseMessage = z.output<typeof statusResponseTransportSchema>;

export const upstreamTransportSchema = z.union([
  registerTransportSchema,
  registerOkTransportSchema,
  registerRejectedTransportSchema,
  heartbeatTransportSchema,
  toolEventTransportSchema,
  toolDoneTransportSchema,
  toolErrorTransportSchema,
  sessionCreatedTransportSchema,
  statusResponseTransportSchema,
]);
export type UpstreamTransportMessage = z.output<typeof upstreamTransportSchema>;
