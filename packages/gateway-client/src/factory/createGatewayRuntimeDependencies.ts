import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import { buildAuthSubprotocol } from '../auth/AkSkAuthProvider.ts';
import { DefaultReconnectPolicy } from '../adapters/DefaultReconnectPolicy.ts';
import { GatewaySchemaCodecAdapter } from '../adapters/GatewaySchemaCodecAdapter.ts';
import { WebSocketGatewayTransport } from '../adapters/WebSocketGatewayTransport.ts';
import { IntervalHeartbeatScheduler } from '../adapters/IntervalHeartbeatScheduler.ts';
import { TimeoutReconnectScheduler } from '../adapters/TimeoutReconnectScheduler.ts';
import { ControlMessageHandler } from '../application/handlers/ControlMessageHandler.ts';
import { BusinessMessageHandler } from '../application/handlers/BusinessMessageHandler.ts';
import type { GatewayClientRuntimeDependencies } from '../application/GatewayClientRuntime.ts';
import { DefaultOutboundProtocolGate } from '../application/protocol/OutboundProtocolGate.ts';
import { GATEWAY_RECONNECT_JITTER, type GatewayReconnectConfig } from '../domain/reconnect.ts';

const DEFAULT_RECONNECT_CONFIG: Required<GatewayReconnectConfig> = {
  baseMs: 1000,
  maxMs: 30000,
  exponential: true,
  jitter: GATEWAY_RECONNECT_JITTER.NONE,
  maxElapsedMs: 600000,
  enabled: true,
};

// resolveStandardReconnectPreset 统一解析共享 reconnect preset，避免 runtime 再持有默认值。
function resolveStandardReconnectPreset(options: GatewayClientOptions): Required<GatewayReconnectConfig> {
  return {
    ...DEFAULT_RECONNECT_CONFIG,
    ...(options.reconnect ?? {}),
  };
}

/**
 * gateway-client 的统一依赖装配入口。
 * @remarks 在 composition root 解析默认策略，确保 runtime 只消费稳定依赖，不再持有隐式默认值。
 * @param options 网关客户端完整配置与覆写项。
 * @returns 运行时编排所需的依赖对象。
 */
export function createGatewayRuntimeDependencies(options: GatewayClientOptions): GatewayClientRuntimeDependencies {
  const wireCodec = options.wireCodec ?? new GatewaySchemaCodecAdapter();
  const reconnectPreset = resolveStandardReconnectPreset(options);
  const reconnectPolicy = options.reconnectPolicy ?? new DefaultReconnectPolicy(
    reconnectPreset,
    { clock: options.clock, random: options.random },
  );

  return {
    transport: new WebSocketGatewayTransport({ webSocketFactory: options.webSocketFactory }),
    heartbeatScheduler: new IntervalHeartbeatScheduler(),
    reconnectScheduler: options.reconnectScheduler ?? new TimeoutReconnectScheduler(),
    reconnectEnabled: reconnectPreset.enabled,
    reconnectPolicy,
    wireCodec,
    outboundProtocolGate: new DefaultOutboundProtocolGate(wireCodec),
    controlMessageHandler: new ControlMessageHandler(),
    businessMessageHandler: new BusinessMessageHandler(),
    authSubprotocolBuilder: buildAuthSubprotocol,
  };
}
