import type { BusinessEntryKey } from '../../domain/session-isolation/index.js';

export interface BusinessEntryKeyResolverInput {
  extParameters?: unknown;
  context?: {
    assistantAccount?: string;
    sendUserAccount?: string;
  };
}

export interface BusinessEntryKeyResolver {
  resolve(input: BusinessEntryKeyResolverInput): BusinessEntryKey | undefined;
}
