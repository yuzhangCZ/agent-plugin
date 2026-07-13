import type { ActiveRunChatPolicy, RequestRunPolicyOptions } from '../public-contract.ts';

export interface ResolvedRequestRunPolicy {
  activeRunChatPolicy: ActiveRunChatPolicy;
}

export const DEFAULT_ACTIVE_RUN_CHAT_POLICY: ActiveRunChatPolicy = 'reject';

export function resolveRequestRunPolicy(options?: RequestRunPolicyOptions): ResolvedRequestRunPolicy {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
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
