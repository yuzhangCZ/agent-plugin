import type { HeartbeatMessage } from '@agent-plugin/gateway-wire-v1';

import type { GatewayClientState } from '../domain/state.ts';
import type { GatewayClientErrorShape } from '../domain/error-contract.ts';
import type {
  GatewayBusinessMessage,
  GatewayInboundFrame,
  GatewayOutboundMessage,
} from './GatewayClientMessages.ts';

/**
 * GatewayClient 对外事件契约。
 */
export interface GatewayClientEvents {
  /** 连接状态变更事件。 */
  stateChange: (state: GatewayClientState) => void;
  /** 业务层可消费消息事件（已通过 READY gating）。 */
  message: (message: GatewayBusinessMessage) => void;
  /** 结构化入站帧观测事件。 */
  inbound: (message: GatewayInboundFrame) => void;
  /** 原始出站帧观测事件，包含业务负载与内部控制帧。 */
  outbound: (message: GatewayOutboundMessage) => void;
  /** 本端心跳发送观测事件。 */
  heartbeat: (message: HeartbeatMessage) => void;
  /** 统一错误事件。 */
  error: (error: GatewayClientErrorShape) => void;
}
