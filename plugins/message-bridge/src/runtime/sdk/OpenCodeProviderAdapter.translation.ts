import { randomUUID } from 'node:crypto';

import type {
  MessageDoneFact,
  MessageStartFact,
  PermissionAskFact,
  PermissionReplyFact,
  QuestionAskFact,
  QuestionOption,
  SessionErrorFact,
  SessionTitleFact,
  TextDeltaFact,
  TextDoneFact,
  ThinkingDeltaFact,
  ThinkingDoneFact,
  ToolUpdateFact,
} from '@wecode/bridge-runtime-sdk';
import { asNumber, asRecord, asString, asTrimmedString } from '../../utils/type-guards.js';
import type {
  RawEventTranslation,
  TranslationContext,
} from './OpenCodeProviderAdapter.types.js';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function buildDeterministicEnvelopeMessageId(prefix: string, token: string): string {
  return `${prefix}:${token}`;
}

function buildSyntheticPartId(): string {
  return `prt_${randomUUID().replaceAll('-', '')}`;
}

function resolveGeneratedPartId(properties: Record<string, unknown> | undefined): string | undefined {
  return asTrimmedString(properties?.partID);
}

function buildFactRoutingFields(
  context: TranslationContext,
): Pick<MessageStartFact, 'subagentSessionId' | 'subagentName'> {
  return {
    ...(context.factSessionContext.subagentSessionId
      ? { subagentSessionId: context.factSessionContext.subagentSessionId }
      : {}),
    ...(context.factSessionContext.subagentName
      ? { subagentName: context.factSessionContext.subagentName }
      : {}),
  };
}

function rejectFactWithoutOpenMessage(
  context: TranslationContext,
  code: string,
  input: {
    trackingSessionId: string;
    messageId: string;
    envelopeMessageId: string;
    partId?: string;
    partType?: string;
  },
): RawEventTranslation {
  context.diagnostics.warn(code, {
    toolSessionId: input.trackingSessionId,
    messageId: input.messageId,
    ...(input.partId ? { partId: input.partId } : {}),
    ...(input.partType ? { partType: input.partType } : {}),
  });
  return {
    recognized: true,
    toolSessionId: context.factSessionContext.anchorSessionId,
    envelopeMessageId: input.envelopeMessageId,
    facts: [],
  };
}

interface EventTranslator {
  translate(context: TranslationContext): RawEventTranslation;
}

export class EventTranslatorRegistry {
  private readonly translators = new Map<string, EventTranslator>();

  register(eventType: string, translator: EventTranslator): this {
    this.translators.set(eventType, translator);
    return this;
  }

  recognizes(eventType: string): boolean {
    return this.translators.has(eventType);
  }

  translate(context: TranslationContext): RawEventTranslation {
    const translator = this.translators.get(context.event.type);
    if (!translator) {
      return { recognized: false, facts: [] };
    }
    return translator.translate(context);
  }
}

export class AssistantMessageEventTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const info = asObject(properties?.info);
    const messageId = asTrimmedString(info?.id);
    if (!asTrimmedString(info?.sessionID) || !messageId) {
      return { recognized: true, facts: [] };
    }

    const factRoutingFields = buildFactRoutingFields(context);
    const role = asTrimmedString(info?.role);
    if (role !== 'assistant') {
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: messageId,
        facts: [],
      };
    }

    const time = asObject(info?.time);
    const hasCreated = time && 'created' in time && time.created !== undefined && time.created !== null;
    const hasCompleted = time && 'completed' in time && time.completed !== undefined && time.completed !== null;
    const finish = asTrimmedString(info?.finish);
    const error = asObject(info?.error);
    const state = context.assistantMessageState.ensure(context.factSessionContext.trackingSessionId, messageId);
    const facts = [];

    if (hasCreated && !state.startEmitted) {
      state.startEmitted = true;
      facts.push({
        type: 'message.start',
        ...factRoutingFields,
        messageId,
        raw: properties,
      } satisfies MessageStartFact);
    }

    let terminalCandidateMessageId: string | undefined;
    if (hasCompleted) {
      const isTerminalCandidate = Boolean(error) || Boolean(finish && finish !== 'tool-calls' && finish !== 'unknown');
      if (!state.startEmitted) {
        context.diagnostics.warn('assistant_message_completed_without_created', {
          toolSessionId: context.factSessionContext.trackingSessionId,
          messageId,
          finish: finish ?? null,
          hasError: Boolean(error),
        });
      } else if (!state.doneEmitted) {
        state.doneEmitted = true;
        facts.push({
          type: 'message.done',
          ...factRoutingFields,
          messageId,
          ...(finish ? { reason: finish } : {}),
          ...(asRecord(info?.tokens) ? { tokens: asRecord(info?.tokens) } : {}),
          ...(asNumber(info?.cost) !== undefined ? { cost: asNumber(info?.cost) } : {}),
          raw: properties,
        } satisfies MessageDoneFact);
      }

      if (isTerminalCandidate) {
        terminalCandidateMessageId = messageId;
      }
    }

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: messageId,
      facts,
      terminalCandidateMessageId,
    };
  }
}

export class MessagePartDeltaTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const messageId = asTrimmedString(properties?.messageID);
    const partId = asTrimmedString(properties?.partID);
    const content = asString(properties?.delta) ?? '';
    if (!asTrimmedString(properties?.sessionID) || !messageId || !partId) {
      return { recognized: true, facts: [] };
    }

    const trackingSessionId = context.factSessionContext.trackingSessionId;
    const factRoutingFields = buildFactRoutingFields(context);
    const kind = context.partKindState.resolve(trackingSessionId, partId);
    if (!context.assistantMessageState.isOpen(trackingSessionId, messageId)) {
      return rejectFactWithoutOpenMessage(
        context,
        kind === 'reasoning' ? 'thinking_delta_without_open_message' : 'text_delta_without_open_message',
        {
          trackingSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType: kind === 'reasoning' ? 'reasoning' : 'text',
        },
      );
    }

    const fact: TextDeltaFact | ThinkingDeltaFact = kind === 'reasoning'
      ? {
          type: 'thinking.delta',
          ...factRoutingFields,
          messageId,
          partId,
          content,
          raw: properties,
        }
      : {
          type: 'text.delta',
          ...factRoutingFields,
          messageId,
          partId,
          content,
          raw: properties,
        };

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: messageId,
      facts: [fact],
    };
  }
}

export class MessagePartUpdatedTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const part = asObject(properties?.part);
    const messageId = asTrimmedString(part?.messageID);
    const partId = asTrimmedString(part?.id);
    const partType = asTrimmedString(part?.type);
    if (!asTrimmedString(part?.sessionID) || !messageId || !partId || !partType) {
      return { recognized: true, facts: [] };
    }

    const trackingSessionId = context.factSessionContext.trackingSessionId;
    const factRoutingFields = buildFactRoutingFields(context);

    if (partType === 'step-start' || partType === 'step-finish') {
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: messageId,
        facts: [],
      };
    }

    if (partType === 'text') {
      context.partKindState.remember(trackingSessionId, partId, 'text');
      if (!context.assistantMessageState.isOpen(trackingSessionId, messageId)) {
        return rejectFactWithoutOpenMessage(context, 'text_done_without_open_message', {
          trackingSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType,
        });
      }
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: messageId,
        facts: [{
          type: 'text.done',
          ...factRoutingFields,
          messageId,
          partId,
          content: asString(part?.text) ?? '',
          raw: properties,
        } satisfies TextDoneFact],
      };
    }

    if (partType === 'reasoning') {
      context.partKindState.remember(trackingSessionId, partId, 'reasoning');
      const partTime = asObject(part?.time);
      const hasEnded = partTime && 'end' in partTime && partTime.end !== undefined && partTime.end !== null;
      if (!hasEnded) {
        return {
          recognized: true,
          toolSessionId: context.factSessionContext.anchorSessionId,
          envelopeMessageId: messageId,
          facts: [],
        };
      }
      if (!context.assistantMessageState.isOpen(trackingSessionId, messageId)) {
        return rejectFactWithoutOpenMessage(context, 'thinking_done_without_open_message', {
          trackingSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType,
        });
      }
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: messageId,
        facts: [{
          type: 'thinking.done',
          ...factRoutingFields,
          messageId,
          partId,
          content: asString(part?.text) ?? '',
          raw: properties,
        } satisfies ThinkingDoneFact],
      };
    }

    if (partType === 'tool') {
      const state = asObject(part?.state);
      const toolCallId = asTrimmedString(part?.callID) ?? partId;
      const resolvedToolName = asTrimmedString(part?.tool);
      const toolName = resolvedToolName ?? 'tool';
      const status = asTrimmedString(state?.status);
      const normalizedStatus = status === 'running' || status === 'completed' || status === 'error'
        ? status
        : 'pending';
      if (!context.assistantMessageState.isOpen(trackingSessionId, messageId)) {
        return rejectFactWithoutOpenMessage(context, 'tool_update_without_open_message', {
          trackingSessionId,
          messageId,
          envelopeMessageId: messageId,
          partId,
          partType,
        });
      }
      if (!resolvedToolName) {
        context.diagnostics.warn('tool_update_missing_tool_name', {
          toolSessionId: trackingSessionId,
          messageId,
          partId,
          partType,
        });
      }
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: messageId,
        facts: [{
          type: 'tool.update',
          ...factRoutingFields,
          messageId,
          partId,
          toolCallId,
          toolName,
          status: normalizedStatus,
          ...(asTrimmedString(state?.title) ? { title: asTrimmedString(state?.title) } : {}),
          ...(asString(state?.input) ? { input: asString(state?.input) } : {}),
          ...(asString(state?.output) ? { output: asString(state?.output) } : {}),
          ...(asString(state?.error) ? { error: asString(state?.error) } : {}),
          raw: properties,
        } satisfies ToolUpdateFact],
      };
    }

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: messageId,
      facts: [],
    };
  }
}

export class QuestionAskedTranslator implements EventTranslator {
  constructor(private readonly requireOpenMessage: boolean) {}

  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const questionId = asTrimmedString(properties?.id);
    const tool = asObject(properties?.tool);
    const messageId = asTrimmedString(tool?.messageID);
    const questions = Array.isArray(properties?.questions) ? properties.questions : [];
    if (!asTrimmedString(properties?.sessionID) || !questionId || questions.length === 0) {
      return { recognized: true, facts: [] };
    }

    const trackingSessionId = context.factSessionContext.trackingSessionId;
    const factRoutingFields = buildFactRoutingFields(context);
    if (!messageId) {
      context.diagnostics.warn('question_ask_missing_message_id', {
        toolSessionId: trackingSessionId,
        questionId,
      });
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: buildDeterministicEnvelopeMessageId('question', questionId),
        facts: [],
      };
    }

    if (this.requireOpenMessage && !context.assistantMessageState.isOpen(trackingSessionId, messageId)) {
      context.diagnostics.warn('question_ask_rejected_without_open_message', {
        toolSessionId: trackingSessionId,
        questionId,
        messageId,
      });
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: messageId,
        facts: [],
      };
    }

    // questionId 只承担 reply target 语义；缺少上游 part 主键时生成独立 partId，避免混淆展示节点身份。
    const partId = resolveGeneratedPartId(properties) ?? buildSyntheticPartId();
    const fact: QuestionAskFact = {
      type: 'question.ask',
      ...factRoutingFields,
      messageId,
      partId,
      questionId,
      questions: questions
        .map((item) => asObject(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({
          question: asString(item.question) ?? '',
          ...(asTrimmedString(item.header) ? { header: asTrimmedString(item.header) } : {}),
          ...(Array.isArray(item.options)
            ? {
                options: item.options
                  .map((option) => asObject(option))
                  .filter((option): option is Record<string, unknown> => Boolean(option))
                  .map((option) => {
                    const label = asString(option.label);
                    if (label === undefined) {
                      return undefined;
                    }
                    const description = asString(option.description);
                    return {
                      label,
                      ...(description !== undefined ? { description } : {}),
                    };
                  })
                  .filter((option): option is QuestionOption => option !== undefined),
              }
            : {}),
          ...(typeof item.multiple === 'boolean' ? { multiSelect: item.multiple } : {}),
        })),
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: messageId,
      facts: [fact],
    };
  }
}

export class PermissionAskedTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const permissionId = asTrimmedString(properties?.id);
    if (!asTrimmedString(properties?.sessionID) || !permissionId) {
      return { recognized: true, facts: [] };
    }
    const permType = asTrimmedString(properties?.permission) ?? asTrimmedString(properties?.type);
    if (!permType) {
      context.diagnostics.warn('permission_ask_missing_perm_type', {
        toolSessionId: context.factSessionContext.trackingSessionId,
        permissionId,
      });
      return {
        recognized: true,
        toolSessionId: context.factSessionContext.anchorSessionId,
        envelopeMessageId: buildDeterministicEnvelopeMessageId('permission', permissionId),
        facts: [],
      };
    }

    const factRoutingFields = buildFactRoutingFields(context);
    const tool = asObject(properties?.tool);
    const messageId = asTrimmedString(tool?.messageID) ?? asTrimmedString(properties?.messageID) ?? undefined;
    // permissionId 只承担 reply target 语义；缺少上游 part 主键时生成独立 partId，避免混淆展示节点身份。
    const partId = resolveGeneratedPartId(properties) ?? buildSyntheticPartId();
    const fact: PermissionAskFact = {
      type: 'permission.ask',
      ...factRoutingFields,
      ...(messageId ? { messageId } : {}),
      partId,
      permissionId,
      permType,
      ...(asObject(properties?.metadata) ? { metadata: asObject(properties?.metadata) } : {}),
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: messageId ?? buildDeterministicEnvelopeMessageId('permission', permissionId),
      facts: [fact],
    };
  }
}

export class PermissionRepliedTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const permissionId = asTrimmedString(properties?.requestID);
    const response = asTrimmedString(properties?.reply);
    if (!asTrimmedString(properties?.sessionID) || !permissionId || !response) {
      return { recognized: true, facts: [] };
    }
    if (response !== 'once' && response !== 'always' && response !== 'reject') {
      return { recognized: true, facts: [] };
    }

    const factRoutingFields = buildFactRoutingFields(context);
    const fact: PermissionReplyFact = {
      type: 'permission.reply',
      ...factRoutingFields,
      permissionId,
      response,
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: buildDeterministicEnvelopeMessageId('permission-reply', permissionId),
      facts: [fact],
    };
  }
}

export class SessionErrorTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const errorObject = asObject(properties?.error);
    const errorText = asTrimmedString(properties?.error) ?? asTrimmedString(errorObject?.message);
    const rawSessionId = asTrimmedString(properties?.sessionID);
    if (!rawSessionId || !errorText) {
      return { recognized: true, facts: [] };
    }

    const factRoutingFields = buildFactRoutingFields(context);
    const fact: SessionErrorFact = {
      type: 'session.error',
      ...factRoutingFields,
      error: {
        code: 'internal_error',
        message: errorText,
      },
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: buildDeterministicEnvelopeMessageId('session-error', rawSessionId),
      facts: [fact],
    };
  }
}

export class SessionUpdatedTranslator implements EventTranslator {
  translate(context: TranslationContext): RawEventTranslation {
    const properties = asObject(context.event.properties);
    const info = asObject(properties?.info);
    const rawSessionId = asTrimmedString(info?.id);
    const title = asTrimmedString(info?.title);
    if (!rawSessionId || !title) {
      context.observation.sessionUpdatedIgnored(!rawSessionId ? 'missing_session_id' : 'missing_title');
      return { recognized: true, facts: [] };
    }

    const factRoutingFields = buildFactRoutingFields(context);
    const fact: SessionTitleFact = {
      type: 'session.title',
      ...factRoutingFields,
      title,
      raw: properties,
    };

    return {
      recognized: true,
      toolSessionId: context.factSessionContext.anchorSessionId,
      envelopeMessageId: buildDeterministicEnvelopeMessageId('session-title', rawSessionId),
      facts: [fact],
    };
  }
}
