import type { HostSessionRecord } from '../records/index.js';

export type RuntimeAppliedResult = { applied: true };

export type ChatCommandResult =
  | { kind: 'prompted'; toolSessionId: string; sessionId: string }
  | { kind: 'synthetic_reply'; toolSessionId: string };

export type CreateSessionCommandResult =
  | { kind: 'entry_owned'; toolSessionId: string; session: HostSessionRecord }
  | { kind: 'anchor_only'; toolSessionId: string };

export type CreateOwnedSessionResult = {
  session: HostSessionRecord;
};

export type CloseOwnedSessionResult =
  | { kind: 'closed'; sessionId: string }
  | { kind: 'not_bound' };

export type AbortAnchoredRunResult =
  | { kind: 'aborted'; toolSessionId: string }
  | { kind: 'not_active'; toolSessionId: string };

export type QuestionReplyCommandResult = RuntimeAppliedResult;

export type PermissionReplyCommandResult = RuntimeAppliedResult;

export type OwnedSessionMutationResult = RuntimeAppliedResult;

export type ResolvedEntrySessionContext = {
  toolSessionId: string;
  bindingSessionId?: string;
  session?: HostSessionRecord;
  visibleSessions: HostSessionRecord[];
};

export type InteractionLookupResult =
  | { kind: 'found'; toolSessionId: string; sessionId: string }
  | { kind: 'missing' };

export type HostEventHandleResult =
  | { kind: 'forwarded'; toolSessionId: string }
  | { kind: 'reconciled'; sessionId: string }
  | { kind: 'dropped'; reason: 'anchor_missing' | 'not_visible' | 'unsupported_event' }
  | { kind: 'ignored'; reason: 'unowned_event' | 'unrelated_event' };

export type EventOwnershipResolution =
  | { kind: 'owned'; sessionId: string; toolSessionId: string }
  | { kind: 'anchor_missing'; sessionId: string }
  | { kind: 'unowned'; sessionId: string };
