import type { BusinessEntryKey } from '../../../../domain/session-isolation/index.js';
import type { SlashCommandDescriptor } from '../../../SlashCommandControlPlanePort.js';

export interface BusinessEntryPolicy {
  entryKey: string;
  controlled: boolean;
  allowOpencodeNativeSessions: boolean;
  allowedSlashCommands: SlashCommandDescriptor['kind'][];
  slashPolicySource?: 'entry_template' | 'request_payload';
}

export interface ChatContextQuery {
  toolSessionId: string;
  entryKey: BusinessEntryKey;
  policy: BusinessEntryPolicy;
  directory?: string;
  roots?: boolean;
  start?: number;
}

export interface CreateSessionCommandInput {
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
  directory?: string;
}
