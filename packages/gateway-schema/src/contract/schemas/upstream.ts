import { z } from 'zod';

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
 * upstream transport 上行协议 union。
 * @remarks 仅覆盖 plugin -> gateway 的 control + business，不包含 gateway -> plugin downstream。
 */
export const gatewayUpstreamTransportMessageSchema = z.union([
  gatewayTransportControlMessageSchema,
  gatewayUplinkBusinessMessageSchema,
]);
export type GatewayUpstreamTransportMessage = z.output<typeof gatewayUpstreamTransportMessageSchema>;

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
