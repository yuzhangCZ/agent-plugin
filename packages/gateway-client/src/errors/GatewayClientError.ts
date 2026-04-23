import type {
  GatewayClientErrorCode,
  GatewayClientErrorDetails,
  GatewayClientErrorShape,
  GatewayConnectionDisposition,
  GatewayConnectionStage,
} from '../domain/error-contract.ts';

export type { GatewayClientErrorCode } from '../domain/error-contract.ts';

/**
 * 构造 GatewayClientError 的输入参数。
 */
export interface GatewayClientErrorOptions {
  code: GatewayClientErrorCode;
  disposition: GatewayConnectionDisposition;
  stage: GatewayConnectionStage;
  retryable: boolean;
  message: string;
  details?: GatewayClientErrorDetails;
  cause?: unknown;
}

/**
 * gateway-client 统一错误实现。
 * @remarks 通过稳定的 code/disposition/stage/retryable 保持跨层错误语义一致。
 */
export class GatewayClientError extends Error implements GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly disposition: GatewayConnectionDisposition;
  readonly stage: GatewayConnectionStage;
  readonly retryable: boolean;
  readonly details?: GatewayClientErrorDetails;
  readonly cause?: unknown;

  constructor(options: GatewayClientErrorOptions) {
    super(options.message);
    this.name = 'GatewayClientError';
    this.code = options.code;
    this.disposition = options.disposition;
    this.stage = options.stage;
    this.retryable = options.retryable;
    this.details = options.details;
    this.cause = options.cause;
  }
}
