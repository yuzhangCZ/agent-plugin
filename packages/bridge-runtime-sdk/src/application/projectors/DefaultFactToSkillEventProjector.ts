import type { SkillProviderEvent } from '@agent-plugin/gateway-schema';

import { SKILL_EVENT_PROTOCOL } from '../constants/gateway-messages.ts';
import type { ProviderFact } from '../../domain/provider.ts';
import type { FactToSkillEventProjector } from './projector.types.ts';

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
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: fact.type,
            properties: {
              messageId: fact.messageId,
              partId: fact.partId,
              content: fact.content,
            },
          },
        ];
      case 'tool.update':
        return [
          {
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
          },
        ];
      case 'question.ask':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'question',
            properties: {
              messageId: fact.messageId,
              partId: fact.partId,
              questionId: fact.questionId,
              toolCallId: fact.toolCallId ?? fact.questionId,
              ...(fact.status ? { status: fact.status } : {}),
              ...(fact.extParam !== undefined ? { extParam: fact.extParam } : {}),
              questions: fact.questions.map((question) => ({
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
              })),
            },
          },
        ];
      case 'permission.ask':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'permission.ask',
            properties: {
              partId: fact.partId,
              toolCallId: fact.permissionId,
              permissionId: fact.permissionId,
              ...(fact.messageId ? { messageId: fact.messageId } : {}),
              ...(fact.permissionType ? { permType: fact.permissionType } : {}),
              ...(fact.title ? { title: fact.title } : {}),
              ...(fact.metadata ? { metadata: fact.metadata } : {}),
            },
          },
        ];
      case 'permission.reply':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'permission.reply',
            properties: {
              permissionId: fact.permissionId,
              response: fact.response,
              ...(fact.permissionType ? { permType: fact.permissionType } : {}),
              ...(fact.messageId ? { messageId: fact.messageId } : {}),
              ...(fact.partId ? { partId: fact.partId } : {}),
            },
          },
        ];
      case 'message.start':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'step.start',
            properties: {
              messageId: fact.messageId,
            },
          },
        ];
      case 'message.done':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'step.done',
            properties: {
              messageId: fact.messageId,
              ...(this.toOptionalNumericRecord(fact.tokens) ? { tokens: this.toOptionalNumericRecord(fact.tokens) } : {}),
              ...(fact.cost !== undefined ? { cost: fact.cost } : {}),
              ...(fact.reason ? { reason: fact.reason } : {}),
            },
          },
        ];
      case 'session.title':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'session.title',
            properties: {
              title: fact.title,
            },
          },
        ];
      case 'session.error':
        return [
          {
            protocol: SKILL_EVENT_PROTOCOL.cloud,
            type: 'session.error',
            properties: {
              error: fact.error.message,
            },
          },
        ];
    }
  }

  private toOptionalNumericRecord(value: unknown): Record<string, number> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
}
