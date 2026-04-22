import type { GatewayReconnectConfig } from '../domain/reconnect.ts';

/**
 * 重连策略使用的时间源。
 */
export interface ReconnectClock {
  now(): number;
}

/**
 * 重连策略可继续重试时的决策结果。
 */
export interface ReconnectScheduledDecision {
  ok: true;
  attempt: number;
  delayMs: number;
  elapsedMs: number;
}

/**
 * 重连窗口耗尽时的决策结果。
 */
export interface ReconnectExhaustedDecision {
  ok: false;
  elapsedMs: number;
  maxElapsedMs: number;
}

export type ReconnectDecision = ReconnectScheduledDecision | ReconnectExhaustedDecision;

/**
 * 重连窗口与退避算法端口。
 */
export interface ReconnectPolicy {
  startWindow(): void;
  reset(): void;
  scheduleNextAttempt(): ReconnectDecision;
  getExhaustedDecision(): ReconnectExhaustedDecision | null;
}

export type ReconnectConfig = Required<GatewayReconnectConfig>;
