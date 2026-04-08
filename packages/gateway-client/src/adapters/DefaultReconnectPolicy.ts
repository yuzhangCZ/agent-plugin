import {
  GATEWAY_RECONNECT_JITTER,
  type GatewayReconnectConfig,
} from '../domain/reconnect.ts';
import type {
  ReconnectClock,
  ReconnectDecision,
  ReconnectExhaustedDecision,
  ReconnectPolicy,
} from '../ports/ReconnectPolicy.ts';

const DEFAULT_CLOCK: ReconnectClock = {
  now: () => Date.now(),
};

export class DefaultReconnectPolicy implements ReconnectPolicy {
  private attempt = 0;
  private windowStartedAt: number | null = null;
  private readonly clock: ReconnectClock;
  private readonly random: () => number;
  private readonly config: Required<GatewayReconnectConfig>;

  constructor(
    config: Required<GatewayReconnectConfig>,
    dependencies: { clock?: ReconnectClock; random?: () => number } = {},
  ) {
    this.config = config;
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.random = dependencies.random ?? Math.random;
  }

  startWindow(): void {
    if (this.windowStartedAt === null) {
      this.windowStartedAt = this.clock.now();
    }
  }

  reset(): void {
    this.attempt = 0;
    this.windowStartedAt = null;
  }

  scheduleNextAttempt(): ReconnectDecision {
    this.startWindow();

    const elapsedMs = this.getElapsedMs();
    if (elapsedMs >= this.config.maxElapsedMs) {
      return { ok: false, elapsedMs, maxElapsedMs: this.config.maxElapsedMs };
    }

    this.attempt += 1;
    const cappedDelay = this.config.exponential
      ? Math.min(this.config.baseMs * Math.pow(2, this.attempt - 1), this.config.maxMs)
      : Math.min(this.config.baseMs, this.config.maxMs);
    const delayMs = this.config.jitter === GATEWAY_RECONNECT_JITTER.FULL
      ? Math.floor(this.random() * (cappedDelay + 1))
      : cappedDelay;

    if (elapsedMs + delayMs >= this.config.maxElapsedMs) {
      return { ok: false, elapsedMs, maxElapsedMs: this.config.maxElapsedMs };
    }

    return { ok: true, attempt: this.attempt, delayMs, elapsedMs };
  }

  getExhaustedDecision(): ReconnectExhaustedDecision | null {
    this.startWindow();
    const elapsedMs = this.getElapsedMs();
    return elapsedMs < this.config.maxElapsedMs
      ? null
      : { ok: false, elapsedMs, maxElapsedMs: this.config.maxElapsedMs };
  }

  private getElapsedMs(): number {
    return Math.max(0, this.clock.now() - (this.windowStartedAt ?? this.clock.now()));
  }
}
