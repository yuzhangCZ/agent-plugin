import type { WireErrorCode } from '@agent-plugin/gateway-schema';

/**
 * 前端可见 `tool_error.error` 文案目录。
 * @remarks
 * 统一维护对外错误提示，避免在 use case、coordinator、runtime 装配层散落硬编码。
 */
export class ToolErrorMessageCatalog {
  get(
    key: 'run_already_active' | 'pending_interaction_not_found' | 'request_run_failed' | WireErrorCode,
    segment?: string,
  ): string {
    switch (key) {
      case 'run_already_active':
        return '当前会话正在处理中，请稍后再试';
      case 'pending_interaction_not_found':
        return '当前交互已失效，请刷新后重试';
      case 'request_run_failed':
        return '当前请求处理失败，请重试';
      case 'unsupported_action':
        return `暂不支持该操作类型，请检查版本后重试 (unsupported_action${segment ? `: ${segment}` : ''})`;
      case 'missing_required_field':
      case 'invalid_field_type':
      case 'invalid_field_value':
        return `请求格式异常，请稍后重试 (${key}${segment ? `: ${segment}` : ''})`;
      default:
        return '请求处理异常，请稍后重试';
    }
  }
}
