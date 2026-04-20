import { z } from 'zod';

import { gatewayDownstreamBusinessRequestSchema } from './downstream.ts';
import { gatewayUpstreamTransportMessageSchema } from './upstream.ts';

/**
 * current-state 全量 wire 协议 union。
 * @remarks 这是独立 protocol root，统一承载 downstream request 与 upstream transport 两个方向边界。
 */
export const gatewayWireProtocolSchema = z.union([
  gatewayDownstreamBusinessRequestSchema,
  gatewayUpstreamTransportMessageSchema,
]);
export type GatewayWireProtocol = z.output<typeof gatewayWireProtocolSchema>;
