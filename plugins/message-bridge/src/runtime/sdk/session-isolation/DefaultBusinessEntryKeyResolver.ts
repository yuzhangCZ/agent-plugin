import type { BusinessEntryKey } from '../../../domain/session-isolation/index.js';
import type {
  BusinessEntryKeyResolver,
  BusinessEntryKeyResolverInput,
} from '../../../usecase/session-isolation/index.js';

type BusinessEntryKeyInput = Pick<BusinessEntryKey, 'businessSessionDomain' | 'businessSessionType' | 'businessSessionId'>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNormalizedKeyPart(value: unknown): string | undefined {
  return asTrimmedString(value)?.toLowerCase();
}

function readBusinessEntryKey(input: unknown): BusinessEntryKey | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const key = {
    businessSessionDomain: asNormalizedKeyPart(record.businessSessionDomain),
    businessSessionType: asNormalizedKeyPart(record.businessSessionType),
    businessSessionId: asTrimmedString(record.businessSessionId),
  };
  if (!key.businessSessionDomain || !key.businessSessionType || !key.businessSessionId) {
    return undefined;
  }
  return key as BusinessEntryKeyInput;
}

function readPartialBusinessEntryKey(input: unknown): Partial<BusinessEntryKeyInput> | undefined {
  const record = asRecord(input);
  if (!record) {
    return undefined;
  }
  const key = {
    ...(asNormalizedKeyPart(record.businessSessionDomain)
      ? { businessSessionDomain: asNormalizedKeyPart(record.businessSessionDomain) }
      : {}),
    ...(asNormalizedKeyPart(record.businessSessionType)
      ? { businessSessionType: asNormalizedKeyPart(record.businessSessionType) }
      : {}),
    ...(asTrimmedString(record.businessSessionId)
      ? { businessSessionId: asTrimmedString(record.businessSessionId) }
      : {}),
  };
  return Object.keys(key).length > 0 ? key : undefined;
}

/**
 * 从 gateway 扩展参数解析控制面业务入口 key。
 * @remarks 优先使用显式三元组；缺失时仅在输入携带 miniapp 补全所需字段时 fallback。
 */
export class DefaultBusinessEntryKeyResolver implements BusinessEntryKeyResolver {
  resolve(input: BusinessEntryKeyResolverInput): BusinessEntryKey | undefined {
    const extParameters = asRecord(input.extParameters);
    const fromPlatformExtParam = readBusinessEntryKey(extParameters?.platformExtParam);
    if (fromPlatformExtParam) {
      return fromPlatformExtParam;
    }

    return this.completeChatEntryKey({
      ...input.context,
      platformExtParam: readPartialBusinessEntryKey(extParameters?.platformExtParam),
    });
  }

  private completeChatEntryKey(input: {
    assistantAccount?: string;
    sendUserAccount?: string;
    platformExtParam?: Partial<BusinessEntryKeyInput>;
  } | undefined): BusinessEntryKey | undefined {
    const domain = asNormalizedKeyPart(input?.platformExtParam?.businessSessionDomain);
    if (domain !== 'miniapp') {
      return undefined;
    }
    const sendUserAccount = asTrimmedString(input?.sendUserAccount);
    const assistantAccount = asTrimmedString(input?.assistantAccount);
    const type = asNormalizedKeyPart(input?.platformExtParam?.businessSessionType);

    if (type && type !== 'direct') {
      return undefined;
    }
    const businessSessionId = assistantAccount ?? sendUserAccount;
    if (!businessSessionId) {
      return undefined;
    }
    return {
      businessSessionDomain: 'miniapp',
      businessSessionType: 'direct',
      businessSessionId,
    };
  }
}
