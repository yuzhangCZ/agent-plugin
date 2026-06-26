import type { BusinessEntryKey } from '../../../domain/session-isolation/index.js';
import type { BusinessEntryPolicy } from '../../../port/session-isolation/dto/commands/index.js';
import type { BusinessEntryKeyResolver } from '../../../usecase/session-isolation/index.js';
import { DefaultBusinessEntryKeyResolver } from './DefaultBusinessEntryKeyResolver.js';
import { DefaultBusinessEntryPolicyResolver } from './BusinessEntryPolicyResolver.js';

export type BusinessEntryContext = {
  entryKey: BusinessEntryKey;
  policy: BusinessEntryPolicy;
};

/**
 * 业务入口解析输入。
 * @remarks 只描述可用于解析/fallback 的字段，不携带 chat/list/create_session 这类调用方来源。
 */
export interface BusinessEntryContextResolveInput {
  extParameters?: unknown;
  context?: {
    assistantAccount?: string;
    sendUserAccount?: string;
  };
}

/**
 * 业务入口上下文 resolver 的可选覆盖依赖。
 * @remarks 生产默认无参构造；该入口仅用于测试或特殊装配替换内部策略。
 */
export interface BusinessEntryContextResolverDependencies {
  businessEntryKeyResolver?: BusinessEntryKeyResolver;
  businessEntryPolicyResolver?: DefaultBusinessEntryPolicyResolver;
}

/**
 * 解析一次 request 的业务入口上下文。
 * @remarks resolver 只按输入字段尽力解析；调用方通过 optional/required 入口决定缺失时是否 fail-closed。
 */
export class BusinessEntryContextResolver {
  private readonly businessEntryKeyResolver: BusinessEntryKeyResolver;
  private readonly businessEntryPolicyResolver: DefaultBusinessEntryPolicyResolver;

  constructor(dependencies: BusinessEntryContextResolverDependencies = {}) {
    this.businessEntryKeyResolver = dependencies.businessEntryKeyResolver ?? new DefaultBusinessEntryKeyResolver();
    this.businessEntryPolicyResolver = dependencies.businessEntryPolicyResolver ?? new DefaultBusinessEntryPolicyResolver();
  }

  resolveOptional(input: BusinessEntryContextResolveInput): BusinessEntryContext | undefined {
    const entryKey = this.businessEntryKeyResolver.resolve({
      extParameters: input.extParameters,
      context: input.context,
    });
    if (!entryKey) {
      return undefined;
    }
    return {
      entryKey,
      policy: this.businessEntryPolicyResolver.resolve({
        entryKey,
        extParameters: input.extParameters,
      }),
    };
  }

  resolveRequired(input: BusinessEntryContextResolveInput): BusinessEntryContext {
    const context = this.resolveOptional(input);
    if (!context) {
      throw new Error('business_entry_key_required');
    }
    return context;
  }
}
