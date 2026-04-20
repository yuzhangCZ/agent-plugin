import { z } from 'zod';

import { TRANSPORT_UPSTREAM_MESSAGE_TYPES } from '../literals/upstream.ts';
import { optionalLooseTrimmedString, requiredTrimmedString } from './shared.ts';

const [REGISTER_MESSAGE_TYPE, REGISTER_OK_MESSAGE_TYPE, REGISTER_REJECTED_MESSAGE_TYPE, HEARTBEAT_MESSAGE_TYPE] =
  TRANSPORT_UPSTREAM_MESSAGE_TYPES;

export const registerMessageSchema = z
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
export type RegisterMessage = z.output<typeof registerMessageSchema>;

export const registerOkMessageSchema = z.object({
  type: z.literal(REGISTER_OK_MESSAGE_TYPE),
});
export type RegisterOkMessage = z.output<typeof registerOkMessageSchema>;

export const registerRejectedMessageSchema = z
  .object({
    type: z.literal(REGISTER_REJECTED_MESSAGE_TYPE),
    reason: optionalLooseTrimmedString,
  })
  .transform((message) => ({
    type: message.type,
    ...(message.reason ? { reason: message.reason } : {}),
  }));
export type RegisterRejectedMessage = z.output<typeof registerRejectedMessageSchema>;

export const heartbeatMessageSchema = z.object({
  type: z.literal(HEARTBEAT_MESSAGE_TYPE),
  timestamp: requiredTrimmedString,
});
export type HeartbeatMessage = z.output<typeof heartbeatMessageSchema>;

export const gatewayTransportControlMessageSchema = z.union([
  registerMessageSchema,
  registerOkMessageSchema,
  registerRejectedMessageSchema,
  heartbeatMessageSchema,
]);
export type GatewayTransportControlMessage = z.output<typeof gatewayTransportControlMessageSchema>;
