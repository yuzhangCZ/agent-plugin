import type { SkillProviderEvent } from '@agent-plugin/gateway-schema';

import { SKILL_EVENT_PROTOCOL } from '../constants/gateway-messages.ts';
import type {
  MessageDoneFact,
  MessageStartFact,
  PermissionAskFact,
  PermissionReplyFact,
  ProviderFact,
  QuestionAskFact,
  SessionErrorFact,
  SessionTitleFact,
  TextDeltaFact,
  TextDoneFact,
  ThinkingDeltaFact,
  ThinkingDoneFact,
  ToolUpdateFact,
} from '../../domain/provider.ts';
import type { FactToSkillEventProjector } from './projector.types.ts';
import { toOptionalNumericRecord } from './projector.utils.ts';

/**
 * cloud/skill provider 默认 fact projector。
 */
export class DefaultFactToSkillEventProjector implements FactToSkillEventProjector {
  project(fact: ProviderFact): SkillProviderEvent[] {
    switch (fact.type) {
      case 'text.delta':
      case 'text.done':
      case 'thinking.delta':
      case 'thinking.done':
        return this.projectStreamingContentFact(fact);
      case 'tool.update':
        return this.projectToolUpdateFact(fact);
      case 'question.ask':
        return this.projectQuestionAskFact(fact);
      case 'permission.ask':
        return this.projectPermissionAskFact(fact);
      case 'permission.reply':
        return this.projectPermissionReplyFact(fact);
      case 'message.start':
        return this.projectMessageStartFact(fact);
      case 'message.done':
        return this.projectMessageDoneFact(fact);
      case 'session.title':
        return this.projectSessionTitleFact(fact);
      case 'session.error':
        return this.projectSessionErrorFact(fact);
    }
  }

  private toSingleEvent(event: SkillProviderEvent): SkillProviderEvent[] {
    return [event];
  }

  private projectStreamingContentFact(
    fact: TextDeltaFact | TextDoneFact | ThinkingDeltaFact | ThinkingDoneFact,
  ): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: fact.type,
      properties: {
        messageId: fact.messageId,
        partId: fact.partId,
        content: fact.content,
      },
    });
  }

  private projectToolUpdateFact(fact: ToolUpdateFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'tool.update',
      properties: {
        messageId: fact.messageId,
        partId: fact.partId,
        toolName: fact.toolName,
        status: fact.status,
        toolCallId: fact.toolCallId,
        ...(fact.title ? { title: fact.title } : {}),
        ...(fact.input !== undefined ? { input: fact.input } : {}),
        ...(fact.output !== undefined ? { output: fact.output } : {}),
        ...(fact.error ? { error: fact.error } : {}),
      },
    });
  }

  private projectQuestionAskFact(fact: QuestionAskFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'question',
      properties: {
        messageId: fact.messageId,
        partId: fact.partId,
        questionId: fact.questionId,
        // 旧下游仍可能以 toolCallId 读取 question reply target；这里仅做兼容回填，不改变内部主键语义。
        toolCallId: fact.toolCallId ?? fact.questionId,
        ...(fact.status ? { status: fact.status } : {}),
        ...(fact.extParam !== undefined ? { extParam: fact.extParam } : {}),
        questions: this.toQuestionItems(fact),
      },
    });
  }

  private toQuestionItems(fact: QuestionAskFact) {
    return fact.questions.map((question) => ({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      ...(question.options?.length
        ? {
            options: question.options.map((option) => ({
              label: option.label,
            })),
          }
        : {}),
      ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
    }));
  }

  private projectPermissionAskFact(fact: PermissionAskFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'permission.ask',
      properties: {
        partId: fact.partId,
        permissionId: fact.permissionId,
        ...(fact.messageId ? { messageId: fact.messageId } : {}),
        ...(fact.permissionType ? { permType: fact.permissionType } : {}),
        ...(fact.title ? { title: fact.title } : {}),
        ...(fact.metadata ? { metadata: fact.metadata } : {}),
      },
    });
  }

  private projectPermissionReplyFact(fact: PermissionReplyFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'permission.reply',
      properties: {
        permissionId: fact.permissionId,
        response: fact.response,
        ...(fact.permissionType ? { permType: fact.permissionType } : {}),
        ...(fact.messageId ? { messageId: fact.messageId } : {}),
        ...(fact.partId ? { partId: fact.partId } : {}),
      },
    });
  }

  private projectMessageStartFact(fact: MessageStartFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'step.start',
      properties: {
        messageId: fact.messageId,
      },
    });
  }

  private projectMessageDoneFact(fact: MessageDoneFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'step.done',
      properties: {
        messageId: fact.messageId,
        ...this.toMessageDoneProperties(fact),
      },
    });
  }

  private toMessageDoneProperties(fact: MessageDoneFact) {
    return {
      ...(toOptionalNumericRecord(fact.tokens) ? { tokens: toOptionalNumericRecord(fact.tokens) } : {}),
      ...(fact.cost !== undefined ? { cost: fact.cost } : {}),
      ...(fact.reason ? { reason: fact.reason } : {}),
    };
  }

  private projectSessionTitleFact(fact: SessionTitleFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'session.title',
      properties: {
        title: fact.title,
      },
    });
  }

  private projectSessionErrorFact(fact: SessionErrorFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'session.error',
      properties: {
        error: fact.error.message,
      },
    });
  }
}
