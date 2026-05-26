import type { BusinessEntryKey } from '../../../../domain/session-isolation/index.js';
import type { SlashCommandDescriptor } from '../../../SlashCommandControlPlanePort.js';

export interface BusinessEntryPolicy {
  entryKey: string;
  controlled: boolean;
  allowOpencodeNativeSessions: boolean;
  allowedSlashCommands: SlashCommandDescriptor['kind'][];
}

export interface ChatCommandInput {
  toolSessionId: string;
  text: string;
  welinkSessionId?: string;
  assistantId?: string;
  extParameters?: unknown;
}

export interface ChatContextQuery {
  toolSessionId: string;
  entryKey: BusinessEntryKey;
  policy: BusinessEntryPolicy;
  directory?: string;
}

export interface CreateSessionCommandInput {
  welinkSessionId: string;
  title?: string;
  assistantId?: string;
  directory?: string;
  extParameters?: unknown;
}

export interface CreateOwnedSessionInput {
  toolSessionId: string;
  sessionId: string;
  entryKey: BusinessEntryKey;
  policy?: BusinessEntryPolicy;
  title?: string;
  assistantId?: string;
  directory?: string;
}

export interface CloseOwnedSessionInput {
  toolSessionId: string;
}

export interface SwitchAttachedSessionInput {
  toolSessionId: string;
  sessionId: string;
}

export interface SessionDeletedEventInput {
  sessionId: string;
}

export interface AbortAnchoredRunInput {
  toolSessionId: string;
}

export interface QuestionReplyCommandInput {
  questionId: string;
  answer: string;
}

export interface PermissionReplyCommandInput {
  permissionId: string;
  response: 'once' | 'always' | 'reject';
}

export interface HostSessionCreateInput {
  title?: string;
  assistantId?: string;
  directory?: string;
  control: {
    controlled: boolean;
    permissionProfile: 'default' | 'dialog_only';
  };
}

export interface HostPromptInput {
  sessionId: string;
  text: string;
  assistantId?: string;
}
