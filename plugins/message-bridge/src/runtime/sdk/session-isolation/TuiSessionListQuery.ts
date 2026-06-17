export const TUI_SESSION_LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type TuiSessionListQuery = {
  directory?: string;
  roots: true;
  start: number;
};

/**
 * 构造 TUI 会话列表口径的 host session 查询条件。
 * @remarks normal chat 预处理与 `/sessions`、`/session` 必须复用同一窗口，避免同轮上下文解析和用户可见列表不一致。
 */
export function buildTuiSessionListQuery(directory?: string): TuiSessionListQuery {
  return {
    ...(directory ? { directory } : {}),
    roots: true,
    start: Date.now() - TUI_SESSION_LIST_WINDOW_MS,
  };
}
