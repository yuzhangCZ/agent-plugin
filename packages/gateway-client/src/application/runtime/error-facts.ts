<<<<<<< HEAD
import type { GatewayConnectionStage } from '../../domain/error-contract.ts';
=======
import type { GatewayClientErrorPhase } from '../../domain/error-contract.ts';
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
import type { GatewayRuntimeStatePort } from './GatewayRuntimeContracts.ts';

/**
 * 从公开运行态推导最小稳定错误阶段，避免调用方依赖内部 attempt 步骤名。
 */
<<<<<<< HEAD
export function resolveGatewayClientStage(state: GatewayRuntimeStatePort): GatewayConnectionStage {
  switch (state.getState()) {
    case 'READY':
      return 'ready';
    case 'CONNECTED':
      return 'handshake';
    case 'CONNECTING':
    case 'DISCONNECTED':
      return 'pre_open';
=======
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
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
  }
}
