import type { SkillProviderEvent } from '@agent-plugin/gateway-schema';

import { RuntimeContractError } from '../domain/errors.ts';
import type { ProviderFact } from '../domain/provider.ts';
import type { SessionLifecycleState } from './registries.ts';

export type LifecycleProfileKind = 'request_run' | 'outbound';

export interface LifecycleProfile {
  kind: LifecycleProfileKind;
}

export interface ValidationSessionState {
  terminalReached: boolean;
  openMessages: Set<string>;
  closedMessages: Set<string>;
  openTextParts: Set<string>;
  openThinkingParts: Set<string>;
  knownToolCallIds: Set<string>;
}

export interface ValidationResult {
  accepted: true;
  projectFact: boolean;
  derivedEvents: SkillProviderEvent[];
}

/**
 * 事实流时序校验器。
 */
export class FactSequenceValidator {
  createState(): ValidationSessionState {
    return {
      terminalReached: false,
      openMessages: new Set(),
      closedMessages: new Set(),
      openTextParts: new Set(),
      openThinkingParts: new Set(),
      knownToolCallIds: new Set(),
    };
  }

  markTerminal(state: ValidationSessionState): void {
    state.terminalReached = true;
  }

  consume(
    fact: ProviderFact,
    state: ValidationSessionState,
    profile: LifecycleProfile,
    sessionLifecycle: SessionLifecycleState,
  ): ValidationResult {
    this.assertSessionLifecycle(fact, state, sessionLifecycle);
    this.assertFactOrder(fact, state, profile);

    return {
      accepted: true,
      projectFact: fact.type !== 'message.start' && fact.type !== 'message.done' && fact.type !== 'session.error',
      derivedEvents: this.deriveEvents(fact),
    };
  }

  private assertSessionLifecycle(
    fact: ProviderFact,
    state: ValidationSessionState,
    sessionLifecycle: SessionLifecycleState,
  ): void {
    if (sessionLifecycle === 'closed') {
      throw new RuntimeContractError('fact_sequence_invalid', 'closed session must reject all facts', {
        factType: fact.type,
        toolSessionId: fact.toolSessionId,
      });
    }

    if (state.terminalReached) {
      throw new RuntimeContractError('fact_sequence_invalid', 'facts after terminal are not allowed', {
        factType: fact.type,
      });
    }

    if (sessionLifecycle !== 'aborting') {
      return;
    }

    if (fact.type === 'message.start' || fact.type === 'question.ask' || fact.type === 'permission.ask') {
      throw new RuntimeContractError('fact_sequence_invalid', 'aborting session rejects new activity facts', {
        factType: fact.type,
      });
    }

    if (fact.type === 'tool.update' && !state.knownToolCallIds.has(fact.toolCallId)) {
      throw new RuntimeContractError('fact_sequence_invalid', 'aborting session rejects new toolCallId', {
        toolCallId: fact.toolCallId,
      });
    }
  }

  private assertFactOrder(fact: ProviderFact, state: ValidationSessionState, profile: LifecycleProfile): void {
    switch (fact.type) {
      case 'message.start':
        if (state.closedMessages.has(fact.messageId) || state.openMessages.has(fact.messageId)) {
          throw new RuntimeContractError('fact_sequence_invalid', 'message.start must not reopen an existing message', {
            messageId: fact.messageId,
          });
        }
        state.openMessages.add(fact.messageId);
        return;
      case 'text.delta':
      case 'text.done':
      case 'thinking.delta':
      case 'thinking.done':
      case 'tool.update':
      case 'question.ask':
      case 'permission.ask':
        if (!state.openMessages.has(fact.messageId) || state.closedMessages.has(fact.messageId)) {
          throw new RuntimeContractError('fact_sequence_invalid', `${fact.type} requires an open message`, {
            messageId: fact.messageId,
            factType: fact.type,
          });
        }
        break;
      case 'message.done':
        if (!state.openMessages.has(fact.messageId)) {
          throw new RuntimeContractError('fact_sequence_invalid', 'message.done requires an open message', {
            messageId: fact.messageId,
          });
        }
        state.openMessages.delete(fact.messageId);
        state.closedMessages.add(fact.messageId);
        if (profile.kind === 'outbound') {
          state.terminalReached = true;
        }
        return;
      case 'session.error':
        return;
    }

    if (fact.type === 'text.delta') {
      state.openTextParts.add(`${fact.messageId}:${fact.partId}`);
      return;
    }
    if (fact.type === 'text.done') {
      state.openTextParts.add(`${fact.messageId}:${fact.partId}`);
      state.openTextParts.delete(`${fact.messageId}:${fact.partId}`);
      return;
    }
    if (fact.type === 'thinking.delta') {
      state.openThinkingParts.add(`${fact.messageId}:${fact.partId}`);
      return;
    }
    if (fact.type === 'thinking.done') {
      state.openThinkingParts.add(`${fact.messageId}:${fact.partId}`);
      state.openThinkingParts.delete(`${fact.messageId}:${fact.partId}`);
      return;
    }
    if (fact.type === 'tool.update') {
      state.knownToolCallIds.add(fact.toolCallId);
      return;
    }
    if (fact.type === 'question.ask') {
      state.knownToolCallIds.add(fact.toolCallId);
      return;
    }

  }

  private deriveEvents(fact: ProviderFact): SkillProviderEvent[] {
    if (fact.type === 'message.start') {
      return [
        {
          family: 'skill',
          type: 'step.start',
          properties: {
            messageId: fact.messageId,
          },
        },
      ];
    }

    if (fact.type === 'message.done') {
      return [
        {
          family: 'skill',
          type: 'step.done',
          properties: {
            messageId: fact.messageId,
            ...(fact.tokens !== undefined ? { tokens: fact.tokens } : {}),
            ...(fact.cost !== undefined ? { cost: fact.cost } : {}),
            ...(fact.reason ? { reason: fact.reason } : {}),
          },
        },
      ];
    }

    return [];
  }
}
