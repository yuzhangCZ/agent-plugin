import type { HeartbeatMessage } from '@agent-plugin/gateway-schema';

import type { GatewayClientStatus } from '../../domain/state.ts';
import type { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayClientOptions } from '../../ports/GatewayClientOptions.ts';
import type { GatewayLogger } from '../../ports/LoggerPort.ts';
import type { AkSkAuthPayload } from '../../ports/GatewayAuthProvider.ts';
import type {
  GatewayBusinessMessage,
  GatewayInboundFrame,
  GatewayOutboundMessage,
} from '../../ports/GatewayClientMessages.ts';
import type { GatewayClientTelemetry } from '../telemetry/GatewayClientTelemetry.ts';
import type { GatewayLifecycleSessionToken } from './GatewayLifecycleState.ts';

/**
 * runtime 到 facade 的唯一事件出口。
 */
export interface GatewayRuntimeSink {
  /** 连接状态快照变更时触发，作为 facade 对外状态事件唯一出口。 */
  emitStatusChange(status: GatewayClientStatus): void;
  /** 有效 attempt 接受进入应用处理链后触发，用于入站观测。 */
  emitInbound(message: GatewayInboundFrame): void;
  /** 出站帧实际发送后触发，用于传输层观测。 */
  emitOutbound(message: GatewayOutboundMessage): void;
  /** 本端心跳帧发送成功后触发，供上层做活性观测。 */
  emitHeartbeat(message: HeartbeatMessage): void;
  /** 业务消息通过 READY gating 后触发，供业务层消费。 */
  emitMessage(message: GatewayBusinessMessage): void;
}

/**
 * 跨协作对象共享的运行时上下文。
 */
export interface GatewayRuntimeContext {
  options: GatewayClientOptions;
  logger?: GatewayLogger;
  telemetry: GatewayClientTelemetry;
  sink: GatewayRuntimeSink;
  abortSignal?: AbortSignal;
  reconnectEnabled: boolean;
  authSubprotocolBuilder: (payload: AkSkAuthPayload) => string;
}

/**
 * 协作对象访问状态机的最小写口。
 */
export interface GatewayRuntimeStatePort {
  /** 读取当前连接状态快照。 */
  getStatus(): GatewayClientStatus;
  /** 判断 transport 是否处于 open 状态。 */
  isConnected(): boolean;
  /** 标记是否由调用方主动终止，用于重连判定。 */
  isManuallyDisconnected(): boolean;
  /** 开始一次 connect/reconnect session。 */
  beginConnect(input: { reconnectAttempt: boolean }): GatewayLifecycleSessionToken;
  /** 当前 session 完成 READY 握手。 */
  finishConnectIfCurrent(token: GatewayLifecycleSessionToken): boolean;
  /** 当前 session 进入自动恢复窗口。 */
  markReconnectingIfCurrent(token: GatewayLifecycleSessionToken): boolean;
  /** 开始自动恢复窗口，返回当前 lifecycle generation。 */
  beginReconnectWindow(): number;
  /** 当前 generation 的重连窗口耗尽。 */
  closeReconnectExhaustedIfCurrent(generation: number): boolean;
  /** 判断 generation 是否仍代表当前 lifecycle 意图。 */
  isCurrentGeneration(generation: number): boolean;
  /** 当前 session 关闭。 */
  closeIfCurrent(token: GatewayLifecycleSessionToken, error: GatewayClientError): boolean;
  /** 判断 session token 是否仍代表当前 lifecycle 意图。 */
  isCurrentSession(token: GatewayLifecycleSessionToken): boolean;
}
