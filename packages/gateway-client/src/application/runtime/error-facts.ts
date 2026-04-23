import type { GatewayConnectionStage } from '../../domain/error-contract.ts';
import type { GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';

/**
 * 从公开运行态推导最小稳定错误阶段，避免调用方依赖内部 attempt 步骤名。
 */
export function resolveGatewayClientStage(state: GatewayRuntimeStatePort): GatewayConnectionStage {
  switch (state.getState()) {
    case 'READY':
      return 'ready';
    case 'CONNECTED':
      return 'handshake';
    case 'CONNECTING':
    case 'DISCONNECTED':
      return 'pre_open';
  }
}
