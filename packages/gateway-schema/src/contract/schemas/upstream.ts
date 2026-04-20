import { z } from 'zod';

import {
  gatewayDownstreamBusinessRequestSchema,
  type GatewayDownstreamBusinessRequest,
} from './downstream.ts';
import {
  gatewayTransportControlMessageSchema,
  heartbeatMessageSchema,
  registerMessageSchema,
  registerOkMessageSchema,
  registerRejectedMessageSchema,
  type GatewayTransportControlMessage,
  type HeartbeatMessage,
  type RegisterMessage,
  type RegisterOkMessage,
  type RegisterRejectedMessage,
} from './upstream-control.ts';
import {
  gatewayUplinkBusinessMessageSchema,
  sessionCreatedMessageSchema,
  statusResponseMessageSchema,
  toolDoneMessageSchema,
  toolErrorMessageSchema,
  toolEventMessageSchema,
  toolUsageSchema,
  type GatewayUplinkBusinessMessage,
  type SessionCreatedMessage,
  type StatusResponseMessage,
  type ToolDoneMessage,
  type ToolErrorMessage,
  type ToolEventMessage,
  type ToolUsage,
} from './upstream-business.ts';

/**
 * transport-only 上行协议 union。
 * @remarks 仅覆盖 plugin -> gateway 的 control + business，不包含 gateway -> plugin downstream。
 */
export const gatewayTransportMessageSchema = z.union([
  gatewayTransportControlMessageSchema,
  gatewayUplinkBusinessMessageSchema,
]);
export type GatewayTransportMessage = z.output<typeof gatewayTransportMessageSchema>;

/**
 * 当前态全量 wire 协议 union。
 * @remarks 作为 umbrella term 覆盖 downstream request + uplink business + transport control。
 */
export const gatewayWireProtocolSchema = z.union([
  gatewayDownstreamBusinessRequestSchema,
  gatewayUplinkBusinessMessageSchema,
  gatewayTransportControlMessageSchema,
]);
export type GatewayWireProtocol = z.output<typeof gatewayWireProtocolSchema>;

export {
  gatewayTransportControlMessageSchema,
  gatewayUplinkBusinessMessageSchema,
  heartbeatMessageSchema,
  registerMessageSchema,
  registerOkMessageSchema,
  registerRejectedMessageSchema,
  sessionCreatedMessageSchema,
  statusResponseMessageSchema,
  toolDoneMessageSchema,
  toolErrorMessageSchema,
  toolEventMessageSchema,
  toolUsageSchema,
};

export type {
  GatewayDownstreamBusinessRequest,
  GatewayTransportControlMessage,
  GatewayUplinkBusinessMessage,
  HeartbeatMessage,
  RegisterMessage,
  RegisterOkMessage,
  RegisterRejectedMessage,
  SessionCreatedMessage,
  StatusResponseMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  ToolEventMessage,
  ToolUsage,
};
