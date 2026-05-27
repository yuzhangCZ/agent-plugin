import type { BusinessEntryKey } from './BusinessEntryKey.js';

export interface EntryKeyCodec {
  normalize(input: BusinessEntryKey): BusinessEntryKey;
  stringify(input: BusinessEntryKey): string;
}

/**
 * `BusinessEntryKey` 的规范化与稳定字符串编码。
 */
export class DefaultEntryKeyCodec implements EntryKeyCodec {
  normalize(input: BusinessEntryKey): BusinessEntryKey {
    return {
      businessSessionDomain: this.normalizeRequired(input.businessSessionDomain, 'businessSessionDomain').toLowerCase(),
      businessSessionType: this.normalizeRequired(input.businessSessionType, 'businessSessionType').toLowerCase(),
      businessSessionId: this.normalizeRequired(input.businessSessionId, 'businessSessionId'),
    };
  }

  stringify(input: BusinessEntryKey): string {
    const normalized = this.normalize(input);
    return [
      normalized.businessSessionDomain,
      normalized.businessSessionType,
      normalized.businessSessionId,
    ].join(':');
  }

  private normalizeRequired(value: string, field: keyof BusinessEntryKey): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`${field}_required`);
    }
    return normalized;
  }
}
