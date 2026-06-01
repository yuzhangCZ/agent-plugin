import type { SkillProviderEvent } from '@agent-plugin/gateway-schema';

import { SKILL_EVENT_PROTOCOL } from '../constants/gateway-messages.ts';
import type {
  MessageDoneFact,
  MessageStartFact,
  PermissionAskFact,
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
import type { ProjectablePermissionReplyFact, ProjectableProviderFact } from './projectable-provider-fact.ts';
import { toOptionalNumericRecord } from './projector.utils.ts';

/**
 * cloud/skill provider 默认 fact projector。
 */
export class DefaultFactToSkillEventProjector implements FactToSkillEventProjector {
  private readonly projectorByType: Record<ProjectableProviderFact['type'], (fact: ProjectableProviderFact) => SkillProviderEvent[]> = {
    'text.delta': (fact) => this.projectStreamingContentFact(fact as TextDeltaFact),
    'text.done': (fact) => this.projectStreamingContentFact(fact as TextDoneFact),
    'thinking.delta': (fact) => this.projectStreamingContentFact(fact as ThinkingDeltaFact),
    'thinking.done': (fact) => this.projectStreamingContentFact(fact as ThinkingDoneFact),
    'tool.update': (fact) => this.projectToolUpdateFact(fact as ToolUpdateFact),
    'question.ask': (fact) => this.projectQuestionAskFact(fact as QuestionAskFact),
    'permission.ask': (fact) => this.projectPermissionAskFact(fact as PermissionAskFact),
    'permission.reply': (fact) => this.projectPermissionReplyFact(fact as ProjectablePermissionReplyFact),
    'message.start': (fact) => this.projectMessageStartFact(fact as MessageStartFact),
    'message.done': (fact) => this.projectMessageDoneFact(fact as MessageDoneFact),
    'session.title': (fact) => this.projectSessionTitleFact(fact as SessionTitleFact),
    'session.error': (fact) => this.projectSessionErrorFact(fact as SessionErrorFact),
  };

  project(fact: ProjectableProviderFact): SkillProviderEvent[] {
    return this.projectorByType[fact.type](fact);
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
              ...(option.description !== undefined ? { description: option.description } : {}),
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
        permType: fact.permType,
        ...(fact.title ? { title: fact.title } : {}),
        ...(fact.metadata ? { metadata: fact.metadata } : {}),
      },
    });
  }

  private projectPermissionReplyFact(fact: ProjectablePermissionReplyFact): SkillProviderEvent[] {
    return this.toSingleEvent({
      protocol: SKILL_EVENT_PROTOCOL.cloud,
      type: 'permission.reply',
      properties: {
        permissionId: fact.permissionId,
        response: fact.response,
        ...(fact.permType ? { permType: fact.permType } : {}),
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
