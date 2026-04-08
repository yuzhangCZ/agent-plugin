import type { GatewayClientOptions } from '../ports/GatewayClientOptions.ts';
import { buildAuthSubprotocol } from '../auth/AkSkAuthProvider.ts';
import { DefaultReconnectPolicy } from '../adapters/DefaultReconnectPolicy.ts';
import { GatewayWireV1CodecAdapter } from '../adapters/GatewayWireV1CodecAdapter.ts';
import { WebSocketGatewayTransport } from '../adapters/WebSocketGatewayTransport.ts';
import { IntervalHeartbeatScheduler } from '../adapters/IntervalHeartbeatScheduler.ts';
import { TimeoutReconnectScheduler } from '../adapters/TimeoutReconnectScheduler.ts';
import { ControlMessageHandler } from '../application/handlers/ControlMessageHandler.ts';
import { BusinessMessageHandler } from '../application/handlers/BusinessMessageHandler.ts';
import type { GatewayClientRuntimeDependencies } from '../application/GatewayClientRuntime.ts';
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

// createGatewayRuntimeDependencies 是统一 composition root，负责装配 runtime 依赖。
export function createGatewayRuntimeDependencies(options: GatewayClientOptions): GatewayClientRuntimeDependencies {
  const wireCodec = options.wireCodec ?? new GatewayWireV1CodecAdapter();
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
    controlMessageHandler: new ControlMessageHandler(wireCodec),
    businessMessageHandler: new BusinessMessageHandler(),
    authSubprotocolBuilder: buildAuthSubprotocol,
  };
}
