import type { BusinessEntryKey } from '../../../domain/session-isolation/index.js';
import type { ChatCommandInput } from '../../../port/session-isolation/dto/commands/index.js';
import type { BusinessEntryKeyResolver } from '../../../usecase/session-isolation/index.js';

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

/**
 * 从 gateway 扩展参数解析控制面业务入口 key。
 * @remarks create_session 只接受显式三元组；chat 可按历史上下文字段补全，补全失败时 fail-closed。
 */
export class DefaultBusinessEntryKeyResolver implements BusinessEntryKeyResolver {
  resolve(input: Pick<ChatCommandInput, 'welinkSessionId' | 'extParameters'> & {
    source?: 'chat' | 'create_session';
    context?: {
      assistantAccount?: string;
      sendUserAccount?: string;
      imGroupId?: string;
    };
  }): BusinessEntryKey | undefined {
    const extParameters = asRecord(input.extParameters);
    const fromPlatformExtParam = readBusinessEntryKey(extParameters?.platformExtParam);
    if (fromPlatformExtParam) {
      return fromPlatformExtParam;
    }

    if (input.source === 'create_session') {
      return undefined;
    }

    return this.completeChatEntryKey({
      ...input.context,
      extParameters: input.extParameters,
    });
  }

  private completeChatEntryKey(input: {
    assistantAccount?: string;
    sendUserAccount?: string;
    imGroupId?: string;
    extParameters?: unknown;
  } | undefined): BusinessEntryKey | undefined {
    const imGroupId = asTrimmedString(input?.imGroupId);
    const extParameters = asRecord(input?.extParameters);
    if (imGroupId) {
      return {
        businessSessionDomain: 'im',
        businessSessionType: 'group',
        businessSessionId: imGroupId,
      };
    }

    const sendUserAccount = asTrimmedString(input?.sendUserAccount);
    const assistantAccount = asTrimmedString(input?.assistantAccount);
    const platformExtParam = asRecord(extParameters?.platformExtParam);
    if (asNormalizedKeyPart(platformExtParam?.businessSessionDomain) === 'miniapp' && assistantAccount) {
      return {
        businessSessionDomain: 'miniapp',
        businessSessionType: 'direct',
        businessSessionId: assistantAccount,
      };
    }
    if (!sendUserAccount || !assistantAccount) {
      return undefined;
    }
    return {
      businessSessionDomain: 'im',
      businessSessionType: 'direct',
      businessSessionId: `${sendUserAccount}#${assistantAccount}`,
    };
  }
}
