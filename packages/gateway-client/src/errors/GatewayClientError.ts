import type {
  GatewayClientErrorCode,
  GatewayClientErrorPhase,
  GatewayClientErrorShape,
  GatewayClientErrorSource,
} from '../domain/error-contract.ts';

export type { GatewayClientErrorCode } from '../domain/error-contract.ts';

/**
 * 构造 GatewayClientError 的输入参数。
 */
export interface GatewayClientErrorOptions {
  code: GatewayClientErrorCode;
  source: GatewayClientErrorSource;
  phase: GatewayClientErrorPhase;
  retryable: boolean;
  message: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * gateway-client 统一错误实现。
 * @remarks 通过稳定的 code/source/phase/retryable 保持跨层错误语义一致。
 */
export class GatewayClientError extends Error implements GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly source: GatewayClientErrorSource;
  readonly phase: GatewayClientErrorPhase;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(options: GatewayClientErrorOptions) {
    super(options.message);
    this.name = 'GatewayClientError';
    this.code = options.code;
    this.source = options.source;
    this.phase = options.phase;
    this.retryable = options.retryable;
    this.details = options.details;
    this.cause = options.cause;
  }
}
