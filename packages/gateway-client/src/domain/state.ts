import type { GatewayClientError } from '../errors/GatewayClientError.ts';

type GatewayClientStatusKind = 'closed' | 'connecting' | 'ready' | 'reconnecting';

/**
 * Gateway 连接状态的只读快照。
 * @remarks 只通过判断方法暴露语义；具体状态标签是内部实现细节，不进入 public API。
 */
export class GatewayClientStatus {
  readonly #kind: GatewayClientStatusKind;
  readonly #error?: GatewayClientError;

  private constructor(kind: GatewayClientStatusKind, error?: GatewayClientError) {
    this.#kind = kind;
    this.#error = error;
    Object.freeze(this);
  }

  static closed(error?: GatewayClientError): GatewayClientStatus {
    if (error?.disposition === 'diagnostic') {
      throw new Error(`GatewayClientStatus.closed cannot accept diagnostic error ${error.code}`);
    }
    return new GatewayClientStatus('closed', error);
  }

  static connecting(): GatewayClientStatus {
    return new GatewayClientStatus('connecting');
  }

  static ready(): GatewayClientStatus {
    return new GatewayClientStatus('ready');
  }

  static reconnecting(): GatewayClientStatus {
    return new GatewayClientStatus('reconnecting');
  }

  isClosed(): boolean {
    return this.#kind === 'closed';
  }

  isConnecting(): boolean {
    return this.#kind === 'connecting';
  }

  isReady(): boolean {
    return this.#kind === 'ready';
  }

  isReconnecting(): boolean {
    return this.#kind === 'reconnecting';
  }

  isAvailable(): boolean {
    return this.isReady();
  }

  hasError(): boolean {
    return this.#error !== undefined;
  }

  getError(): GatewayClientError | undefined {
    return this.#error;
  }

  isRetryable(): boolean {
    return this.#error?.retryable === true;
  }

  isCancelled(): boolean {
    return this.#error?.disposition === 'cancelled';
  }

  isFailureClosed(): boolean {
    return this.isClosed()
      && (this.#error?.disposition === 'startup_failure'
        || this.#error?.disposition === 'runtime_failure');
  }

  /**
   * 输出用于日志和错误 details 的最小诊断快照。
   * @remarks 这是观测字段，不作为业务状态分支 API；业务判断应继续使用 isReady/isClosed 等语义方法。
   */
  toDiagnosticFields(): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      status: this.#kind,
      available: this.isAvailable(),
    };
    if (!this.#error) {
      return fields;
    }
    fields.errorCode = this.#error.code;
    fields.errorDisposition = this.#error.disposition;
    fields.errorRetryable = this.#error.retryable;
    fields.errorMessage = this.#error.message;
    return fields;
  }
}
