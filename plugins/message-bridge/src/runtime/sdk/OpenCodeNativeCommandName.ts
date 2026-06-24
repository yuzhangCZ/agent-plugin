/**
 * 归一化 OpenCode native command 名称。
 * @remarks OpenCode 执行接口使用不带 `/` 的 command name；列表展示再补 `/`。
 */
export function normalizeOpenCodeNativeCommandName(value: string): string | undefined {
  const trimmed = value.trim();
  const name = trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
  if (!name || /\s/u.test(name) || name.includes('/')) {
    return undefined;
  }
  return name;
}

export function toOpenCodeNativeSlashCommand(value: string): string | undefined {
  const name = normalizeOpenCodeNativeCommandName(value);
  return name ? `/${name}` : undefined;
}
