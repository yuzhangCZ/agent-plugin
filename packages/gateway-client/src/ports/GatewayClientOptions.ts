import type { GatewayClientConfig } from './GatewayClientConfig.ts';
import type { GatewayClientOverrides } from './GatewayClientOverrides.ts';

// GatewayClientOptions 仅作为包内聚合类型存在，不对稳定入口暴露。
export type GatewayClientOptions = GatewayClientConfig & GatewayClientOverrides;
