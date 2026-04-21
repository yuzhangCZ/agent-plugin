import type { HeartbeatMessage } from '@agent-plugin/gateway-schema';

import type { GatewayClientState } from '../../domain/state.ts';
import type { GatewayClientOptions } from '../../ports/GatewayClientOptions.ts';
import type { GatewayLogger } from '../../ports/LoggerPort.ts';
import type { AkSkAuthPayload } from '../../ports/GatewayAuthProvider.ts';
import type {
  GatewayBusinessMessage,
  GatewayInboundFrame,
  GatewayOutboundMessage,
} from '../../ports/GatewayClientMessages.ts';
import type { GatewayClientTelemetry } from '../telemetry/GatewayClientTelemetry.ts';
import { GatewayClientError } from '../../errors/GatewayClientError.ts';

/**
 * runtime 到 facade 的唯一事件出口。
 */
export interface GatewayRuntimeSink {
  /** 状态机状态变更时触发，作为 facade 对外状态事件唯一出口。 */
  emitStateChange(state: GatewayClientState): void;
  /** 有效 attempt 接受进入应用处理链后触发，用于入站观测。 */
  emitInbound(message: GatewayInboundFrame): void;
  /** 出站帧实际发送后触发，用于传输层观测。 */
  emitOutbound(message: GatewayOutboundMessage): void;
  /** 本端心跳帧发送成功后触发，供上层做活性观测。 */
  emitHeartbeat(message: HeartbeatMessage): void;
  /** 业务消息通过 READY gating 后触发，供业务层消费。 */
  emitMessage(message: GatewayBusinessMessage): void;
  /** 运行时错误统一上抛出口，避免协作对象各自发错。 */
  emitError(error: GatewayClientError): void;
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
  reconnectInvoker: () => Promise<void>;
  authSubprotocolBuilder: (payload: AkSkAuthPayload) => string;
}

/**
 * 协作对象访问状态机的最小写口。
 */
export interface GatewayRuntimeStatePort {
  /** 读取当前连接状态。 */
  getState(): GatewayClientState;
  /** 写入下一状态并触发统一状态事件。 */
  setState(next: GatewayClientState): void;
  /** 判断 transport 是否处于 open 状态。 */
  isConnected(): boolean;
  /** 标记是否由调用方主动终止，用于重连判定。 */
  isManuallyDisconnected(): boolean;
  /** 更新调用方主动终止标记。 */
  setManuallyDisconnected(value: boolean): void;
}
