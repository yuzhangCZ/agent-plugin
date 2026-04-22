/**
 * Provider 在命令应用阶段返回的结构化失败。
 */
export interface ProviderCommandError {
  code:
    | 'invalid_input'
    | 'not_found'
    | 'not_supported'
    | 'provider_unavailable'
    | 'internal_error';
  message: string;
  retryable?: boolean;
  // 这里保留 unknown：仅用于边界诊断附加信息，不属于稳定命令语义。
  details?: Record<string, unknown>;
}

/**
 * Provider 在执行期暴露的结构化错误。
 */
export interface ProviderError {
  code:
    | 'not_found'
    | 'invalid_input'
    | 'not_supported'
    | 'timeout'
    | 'rate_limited'
    | 'provider_unavailable'
    | 'internal_error';
  message: string;
  retryable?: boolean;
  // 这里保留 unknown：仅用于执行期诊断附加信息，不属于稳定业务字段。
  details?: Record<string, unknown>;
}

/**
 * runtime 内部 fail-closed 错误。
 */
export class RuntimeContractError extends Error {
  readonly code:
    | 'session_not_found'
    | 'session_closed'
    | 'run_already_active'
    | 'outbound_already_active'
    | 'pending_interaction_not_found'
    | 'fact_sequence_invalid';
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuntimeContractError['code'],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RuntimeContractError';
    this.code = code;
    this.details = details;
  }
}
