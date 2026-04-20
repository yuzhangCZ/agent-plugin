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
 * 当前态全量上行协议 union。
 * @remarks 仅作为 umbrella term 覆盖 business + control，不应替代 `GatewayUplinkBusinessMessage`。
 */
export const gatewayWireProtocolSchema = z.union([
  gatewayTransportControlMessageSchema,
  gatewayUplinkBusinessMessageSchema,
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
