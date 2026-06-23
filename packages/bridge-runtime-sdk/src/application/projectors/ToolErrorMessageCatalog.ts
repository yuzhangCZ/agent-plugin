/**
 * 前端可见 `tool_error.error` 文案目录。
 * @remarks
 * 统一维护对外错误提示，避免在 use case、coordinator、runtime 装配层散落硬编码。
 */
export class ToolErrorMessageCatalog {
  get(key: 'run_already_active' | 'pending_interaction_not_found' | 'request_run_failed'): string {
    switch (key) {
      case 'run_already_active':
        return '当前会话正在处理中，请稍后再试';
      case 'pending_interaction_not_found':
        return '当前交互已失效，请刷新后重试';
      case 'request_run_failed':
        return '当前请求处理失败，请重试';
      default:
        return '当前请求处理失败，请重试';
    }
  }
}
