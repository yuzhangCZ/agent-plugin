import type { HeartbeatMessage } from '@agent-plugin/gateway-wire-v1';

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
  emitStateChange(state: GatewayClientState): void;
  emitInbound(message: GatewayInboundFrame): void;
  emitOutbound(message: GatewayOutboundMessage): void;
  emitHeartbeat(message: HeartbeatMessage): void;
  emitMessage(message: GatewayBusinessMessage): void;
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
  getState(): GatewayClientState;
  setState(next: GatewayClientState): void;
  isConnected(): boolean;
  isManuallyDisconnected(): boolean;
  setManuallyDisconnected(value: boolean): void;
}
