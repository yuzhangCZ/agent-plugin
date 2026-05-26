import type { BridgeEvent } from '../types.js';
import type { ProviderFact } from '../../../../../packages/bridge-runtime-sdk/src/index.ts';

export type PartKind = 'text' | 'reasoning';

export type AssistantMessageLifecycleState = {
  startEmitted: boolean;
  doneEmitted: boolean;
};

export type RawEventTranslation = {
  recognized: boolean;
  toolSessionId?: string;
  envelopeMessageId?: string;
  facts: ProviderFact[];
  terminalCandidateMessageId?: string;
};

export type SessionIdentityResolution =
  | {
      kind: 'resolved';
      rawSessionId: string;
      anchorSessionId: string;
      trackingSessionId: string;
      hostSessionId: string;
      subagentSessionId?: string;
      subagentName?: string;
    }
  | {
      kind: 'resolved_fail_open';
      rawSessionId: string;
      anchorSessionId: string;
      trackingSessionId: string;
      hostSessionId: string;
      lookupFailedCause: unknown;
    }
  | {
      kind: 'anchor_missing';
      rawSessionId: string;
      lookupFailedCause?: unknown;
    };

export type FactSessionContext = {
  anchorSessionId: string;
  trackingSessionId: string;
  subagentSessionId?: string;
  subagentName?: string;
};

export interface ProtocolDiagnosticPort {
  warn(code: string, payload: Record<string, unknown>): void;
}

export interface TranslationObservationPort {
  sessionUpdatedIgnored(reason: 'missing_session_id' | 'missing_title'): void;
}

export interface PendingInteractionRecorderPort {
  record(input: {
    kind: 'question' | 'permission';
    tokenId: string;
    toolSessionId: string;
    hostSessionId: string;
  }): void;
}

export interface AssistantMessageStateStorePort {
  ensure(trackingSessionId: string, messageId: string): AssistantMessageLifecycleState;
  isOpen(trackingSessionId: string, messageId: string): boolean;
  clearSession(trackingSessionId: string): void;
  has(trackingSessionId: string): boolean;
}

export interface PartKindStorePort {
  remember(trackingSessionId: string, partId: string, kind: PartKind): void;
  resolve(trackingSessionId: string, partId: string): PartKind;
  clearSession(trackingSessionId: string): void;
  has(trackingSessionId: string): boolean;
}

export type TranslationContext = {
  event: BridgeEvent;
  factSessionContext: FactSessionContext;
  assistantMessageState: AssistantMessageStateStorePort;
  partKindState: PartKindStorePort;
  diagnostics: ProtocolDiagnosticPort;
  observation: TranslationObservationPort;
};
