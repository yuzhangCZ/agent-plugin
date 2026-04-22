type RetryOnCloseInput = {
  closeCode?: unknown;
  manuallyDisconnected: boolean;
  aborted: boolean;
};

const RETRYABLE_CLOSE_CODES = new Set([1006, 1012, 1013]);

/**
 * 自动重试采用 close code 白名单；未命中白名单时默认 fail-closed。
 */
export function shouldRetryOnClose(input: RetryOnCloseInput): boolean {
  if (input.manuallyDisconnected || input.aborted) {
    return false;
  }

  return typeof input.closeCode === 'number'
    && Number.isFinite(input.closeCode)
    && RETRYABLE_CLOSE_CODES.has(input.closeCode);
}
