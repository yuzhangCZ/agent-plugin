import type { GatewayClientErrorPhase } from '../../domain/error-contract.ts';
import type { GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';

/**
 * 从公开运行态推导最小稳定错误阶段，避免调用方依赖内部 attempt 步骤名。
 */
export function resolveGatewayClientPhase(state: GatewayRuntimeStatePort): GatewayClientErrorPhase {
  if (state.isManuallyDisconnected()) {
    return 'stopping';
  }
  if (state.isReconnecting()) {
    return 'reconnecting';
  }
  switch (state.getState()) {
    case 'READY':
      return 'ready';
    case 'CONNECTING':
    case 'CONNECTED':
      return 'before_ready';
    case 'DISCONNECTED':
      return 'before_open';
  }
}
