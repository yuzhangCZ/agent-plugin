import type { GatewayReconnectConfig } from '../domain/reconnect.ts';

export interface ReconnectClock {
  now(): number;
}

export interface ReconnectScheduledDecision {
  ok: true;
  attempt: number;
  delayMs: number;
  elapsedMs: number;
}

export interface ReconnectExhaustedDecision {
  ok: false;
  elapsedMs: number;
  maxElapsedMs: number;
}

export type ReconnectDecision = ReconnectScheduledDecision | ReconnectExhaustedDecision;

export interface ReconnectPolicy {
  startWindow(): void;
  reset(): void;
  scheduleNextAttempt(): ReconnectDecision;
  getExhaustedDecision(): ReconnectExhaustedDecision | null;
}

export type ReconnectConfig = Required<GatewayReconnectConfig>;
