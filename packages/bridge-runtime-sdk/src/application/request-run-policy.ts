import type { ActiveRunChatPolicy, RequestRunPolicyOptions } from '../public-contract.ts';

export interface ResolvedRequestRunPolicy {
  activeRunChatPolicy: ActiveRunChatPolicy;
}

export const DEFAULT_ACTIVE_RUN_CHAT_POLICY: ActiveRunChatPolicy = 'reject';

export function resolveRequestRunPolicy(options?: RequestRunPolicyOptions): ResolvedRequestRunPolicy {
  const activeRunChatPolicy = options?.activeRunChatPolicy === undefined
    ? DEFAULT_ACTIVE_RUN_CHAT_POLICY
    : options.activeRunChatPolicy;
  if (activeRunChatPolicy !== 'reject' && activeRunChatPolicy !== 'forwardToProvider') {
    throw new TypeError(`Invalid activeRunChatPolicy: ${String(activeRunChatPolicy)}`);
  }
  return { activeRunChatPolicy };
}
