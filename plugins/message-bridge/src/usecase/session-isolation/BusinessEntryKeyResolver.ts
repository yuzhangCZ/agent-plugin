import type { BusinessEntryKey } from '../../domain/session-isolation/index.js';

export interface BusinessEntryKeyResolverInput {
  welinkSessionId?: string;
  extParameters?: unknown;
  source?: 'chat' | 'create_session';
  context?: {
    assistantAccount?: string;
    sendUserAccount?: string;
  };
}

export interface BusinessEntryKeyResolver {
  resolve(input: BusinessEntryKeyResolverInput): BusinessEntryKey | undefined;
}
