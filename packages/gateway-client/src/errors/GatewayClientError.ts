import type {
  GatewayClientErrorCategory,
  GatewayClientErrorCode,
  GatewayClientErrorShape,
} from '../domain/error-contract.ts';

export type { GatewayClientErrorCode } from '../domain/error-contract.ts';

/**
 * 构造 GatewayClientError 的输入参数。
 */
export interface GatewayClientErrorOptions {
  code: GatewayClientErrorCode;
  category: GatewayClientErrorCategory;
  retryable: boolean;
  message: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * gateway-client 统一错误实现。
 * @remarks 通过结构化 code/category/retryable 保持跨层错误语义一致。
 */
export class GatewayClientError extends Error implements GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly category: GatewayClientErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(options: GatewayClientErrorOptions) {
    super(options.message);
    this.name = 'GatewayClientError';
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.details = options.details;
    this.cause = options.cause;
  }
}
