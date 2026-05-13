import { shouldRetryOnClose } from './shouldRetryOnClose.ts';

export type ReconnectCloseDecision =
  | { action: 'stop' }
  | { action: 'start-window' }
  | { action: 'continue-window' };

export interface EvaluateReconnectOnCloseInput {
  closeCode?: unknown;
  manuallyDisconnected: boolean;
  aborted: boolean;
  reconnectEnabled: boolean;
  reconnectAttempt: boolean;
  phase: 'transport-opening' | 'register-sent' | 'ready' | 'terminal';
}

const GATEWAY_REJECTION_CLOSE_CODES = new Set([4403, 4409]);

export function isGatewayRejectedCloseCode(code: unknown): boolean {
  return typeof code === 'number' && Number.isFinite(code) && GATEWAY_REJECTION_CLOSE_CODES.has(code);
}

/**
 * 统一收敛 close 侧自动恢复动作决策；返回值一旦生成，调用方只负责执行对应动作。
 */
export function evaluateReconnectOnClose(input: EvaluateReconnectOnCloseInput): ReconnectCloseDecision {
  const blockedByTerminalOverride =
    input.manuallyDisconnected
    || input.aborted
    || !input.reconnectEnabled
    || isGatewayRejectedCloseCode(input.closeCode);
  if (blockedByTerminalOverride) {
    return { action: 'stop' };
  }

  const eligibleClose = shouldRetryOnClose({
    closeCode: input.closeCode,
    manuallyDisconnected: false,
    aborted: false,
  });
  if (!eligibleClose) {
    return { action: 'stop' };
  }

  if (input.phase === 'ready') {
    return { action: 'start-window' };
  }
  if (input.reconnectAttempt) {
    return { action: 'continue-window' };
  }
  return { action: 'stop' };
}
