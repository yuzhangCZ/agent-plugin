import { classifyFact } from './fact-semantics.ts';
import { RuntimeContractError } from '../domain/errors.ts';
import type { ProviderFact } from '../domain/provider.ts';
import type { SessionLifecycleState } from './ports/session-runtime-registry.ts';

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
    toolSessionId: string,
    fact: ProviderFact,
    state: ValidationSessionState,
    profile: LifecycleProfile,
    sessionLifecycle: SessionLifecycleState,
  ): void {
    this.assertSessionLifecycle(toolSessionId, fact, state, sessionLifecycle);
    this.assertFactOrder(fact, state, profile);
  }

  private assertSessionLifecycle(
    toolSessionId: string,
    fact: ProviderFact,
    state: ValidationSessionState,
    sessionLifecycle: SessionLifecycleState,
  ): void {
    if (sessionLifecycle === 'closed') {
      throw new RuntimeContractError('fact_sequence_invalid', 'closed session must reject all facts', {
        factType: fact.type,
        toolSessionId,
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

    const classification = classifyFact(fact.type);

    if (classification.rejectInAbortingSession) {
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
        if (
          classifyFact(fact.type).requiresOpenMessage
          && (!state.openMessages.has(fact.messageId) || state.closedMessages.has(fact.messageId))
        ) {
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
        if (profile.kind === 'outbound' && classifyFact(fact.type).marksOutboundTerminal) {
          state.terminalReached = true;
        }
        return;
      case 'permission.reply':
      case 'session.title':
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
      if (fact.input !== undefined && typeof fact.input !== 'string') {
        throw new RuntimeContractError('fact_sequence_invalid', 'tool.update input must be a string', {
          toolCallId: fact.toolCallId,
        });
      }
      if (fact.output !== undefined && typeof fact.output !== 'string') {
        throw new RuntimeContractError('fact_sequence_invalid', 'tool.update output must be a string', {
          toolCallId: fact.toolCallId,
        });
      }
      if ((fact.input !== undefined && fact.input.trim().length === 0) || (fact.output !== undefined && fact.output.trim().length === 0)) {
        throw new RuntimeContractError('fact_sequence_invalid', 'tool.update input/output must not be blank strings', {
          toolCallId: fact.toolCallId,
        });
      }
      state.knownToolCallIds.add(fact.toolCallId);
      return;
    }
    if (fact.type === 'question.ask') {
      return;
    }
  }
}
