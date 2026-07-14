import type { ActiveRunChatPolicy, RequestRunPolicyOptions } from '../public-contract.ts';
import { isJsonObject } from '../shared/type-guards.ts';

/**
 * Runtime 使用的已归一化 request run 策略。
 */
export interface ResolvedRequestRunPolicy {
  activeRunChatPolicy: ActiveRunChatPolicy;
}

/**
 * 未配置 active run chat policy 时使用的兼容默认值。
 */
export const DEFAULT_ACTIVE_RUN_CHAT_POLICY: ActiveRunChatPolicy = 'reject';

/**
 * 校验并归一化 public request run policy 配置，确保 runtime 只接收完整策略。
 *
 * @param options - 调用方提供的可选 request run policy 配置
 * @returns 包含显式 active run chat policy 的归一化配置
 * @throws {TypeError} 当配置不是对象或 `activeRunChatPolicy` 不是受支持的值时
 */
export function resolveRequestRunPolicy(options?: RequestRunPolicyOptions): ResolvedRequestRunPolicy {
  if (options !== undefined && !isJsonObject(options)) {
    throw new TypeError(`Invalid requestRunPolicy: ${String(options)}`);
  }

  const activeRunChatPolicy = options?.activeRunChatPolicy === undefined
    ? DEFAULT_ACTIVE_RUN_CHAT_POLICY
    : options.activeRunChatPolicy;
  if (activeRunChatPolicy !== 'reject' && activeRunChatPolicy !== 'forwardToProvider') {
    throw new TypeError(`Invalid activeRunChatPolicy: ${String(activeRunChatPolicy)}`);
  }
  return { activeRunChatPolicy };
}
