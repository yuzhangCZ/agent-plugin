/**
 * gateway-client 依赖的最小日志端口。
 */
export interface GatewayLogger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
  child?: (meta: Record<string, unknown>) => GatewayLogger;
  getTraceId?: () => string;
}
