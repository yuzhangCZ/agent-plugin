import type { ProviderRunMessageInput } from '@wecode/bridge-runtime-sdk';
import type { BusinessEntryKey } from '../../../domain/session-isolation/index.js';
import type { BusinessEntryPolicy } from '../../../port/session-isolation/dto/commands/index.js';
import type { BusinessEntryKeyResolver } from '../../../usecase/session-isolation/index.js';
import type { DefaultBusinessEntryPolicyResolver } from './BusinessEntryPolicyResolver.js';

export type BusinessEntryContext = {
  entryKey: BusinessEntryKey;
  policy: BusinessEntryPolicy;
};

/**
 * 解析一次 request 的业务入口上下文。
 * @remarks slash 与 normal chat 必须复用同一份 entryKey/policy，避免策略绕过。
 */
export class BusinessEntryContextResolver {
  constructor(private readonly dependencies: {
    businessEntryKeyResolver: BusinessEntryKeyResolver;
    businessEntryPolicyResolver: DefaultBusinessEntryPolicyResolver;
  }) {}

  resolveForChatMessage(input: ProviderRunMessageInput): BusinessEntryContext {
    const entryKey = this.dependencies.businessEntryKeyResolver.resolve({
      source: 'chat',
      welinkSessionId: input.traceId,
      extParameters: input.extParameters,
      context: input.context,
    });
    if (!entryKey) {
      throw new Error('business_entry_key_required');
    }
    return {
      entryKey,
      policy: this.dependencies.businessEntryPolicyResolver.resolve({
        entryKey,
        extParameters: input.extParameters,
      }),
    };
  }
}
