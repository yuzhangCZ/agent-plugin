import type {
  BridgeGatewayHostConfig,
  BridgeGatewayHostConnection,
} from '../../infrastructure/gateway/gateway-host.ts';
import type { BridgeRuntimeOptions } from '../create-runtime.ts';

/**
 * Runtime SDK 内部测试缝。
 * @remarks connectionFactory 与 onGatewayConnectionCreated 只用于包内测试和装配验证，
 * 不属于 bridge-runtime-sdk 的 public contract；宿主侧只能通过 gatewayHost 与
 * createBridgeRuntime 创建 runtime。
 */
export type BridgeRuntimeInternalOptions = BridgeRuntimeOptions & {
  connectionFactory?: (config: BridgeGatewayHostConfig) => BridgeGatewayHostConnection;
  onGatewayConnectionCreated?: (connection: BridgeGatewayHostConnection) => void;
};
