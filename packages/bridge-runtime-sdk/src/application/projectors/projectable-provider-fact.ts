import type {
  PermissionReplyFact,
  ProviderFact,
} from '../../domain/provider.ts';

export interface ProjectablePermissionReplyFact extends PermissionReplyFact {
  messageId?: string;
  partId: string;
}

export type ProjectableProviderFact =
  | Exclude<ProviderFact, { type: 'permission.reply' }>
  | ProjectablePermissionReplyFact;
