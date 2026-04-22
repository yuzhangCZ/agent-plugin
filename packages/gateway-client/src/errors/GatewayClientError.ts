import type {
  GatewayClientErrorCode,
<<<<<<< HEAD
  GatewayClientErrorDetails,
  GatewayClientErrorShape,
  GatewayConnectionDisposition,
  GatewayConnectionStage,
=======
  GatewayClientErrorPhase,
  GatewayClientErrorShape,
  GatewayClientErrorSource,
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
} from '../domain/error-contract.ts';

export type { GatewayClientErrorCode } from '../domain/error-contract.ts';

/**
 * 构造 GatewayClientError 的输入参数。
 */
export interface GatewayClientErrorOptions {
  code: GatewayClientErrorCode;
<<<<<<< HEAD
  disposition: GatewayConnectionDisposition;
  stage: GatewayConnectionStage;
=======
  source: GatewayClientErrorSource;
  phase: GatewayClientErrorPhase;
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
  retryable: boolean;
  message: string;
  details?: GatewayClientErrorDetails;
  cause?: unknown;
}

/**
 * gateway-client 统一错误实现。
<<<<<<< HEAD
 * @remarks 通过稳定的 code/disposition/stage/retryable 保持跨层错误语义一致。
 */
export class GatewayClientError extends Error implements GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly disposition: GatewayConnectionDisposition;
  readonly stage: GatewayConnectionStage;
=======
 * @remarks 通过稳定的 code/source/phase/retryable 保持跨层错误语义一致。
 */
export class GatewayClientError extends Error implements GatewayClientErrorShape {
  readonly code: GatewayClientErrorCode;
  readonly source: GatewayClientErrorSource;
  readonly phase: GatewayClientErrorPhase;
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
  readonly retryable: boolean;
  readonly details?: GatewayClientErrorDetails;
  readonly cause?: unknown;

  constructor(options: GatewayClientErrorOptions) {
    super(options.message);
    this.name = 'GatewayClientError';
    this.code = options.code;
<<<<<<< HEAD
    this.disposition = options.disposition;
    this.stage = options.stage;
=======
    this.source = options.source;
    this.phase = options.phase;
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
    this.retryable = options.retryable;
    this.details = options.details;
    this.cause = options.cause;
  }
}
