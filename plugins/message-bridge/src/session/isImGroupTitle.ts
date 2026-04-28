const IM_GROUP_TITLE_PREFIX = /^im-group/;

/**
 * 统一判定 create_session title 是否代表 IM 群聊会话。
 * @remarks 这里必须与权限收紧和群聊缓存建立共用同一规则，避免行为漂移。
 */
export function isImGroupTitle(title?: string): boolean {
  return typeof title === 'string' && IM_GROUP_TITLE_PREFIX.test(title);
}
