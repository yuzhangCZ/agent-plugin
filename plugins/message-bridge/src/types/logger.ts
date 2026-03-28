export type BridgeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BridgeLogger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): BridgeLogger;
  getTraceId(): string;
}
