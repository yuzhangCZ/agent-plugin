import type {
  GatewayUplinkBusinessMessage,
  SessionCreatedMessage,
  SkillProviderEvent,
  StatusResponseMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  ToolEventMessage,
} from '@agent-plugin/gateway-schema';

import type { ProviderFact, ProviderTerminalResult } from '../domain/provider.ts';

type ToolEventEnvelopeFields = {
  subagentSessionId?: string;
  subagentName?: string;
};

function toOptionalNumericRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * runtime 统一上行发送端口。
 */
export interface GatewayOutboundSink {
  send(message: GatewayUplinkBusinessMessage): Promise<void> | void;
}

/**
 * `ProviderFact -> SkillProviderEvent` 投影端口。
 */
export interface FactToSkillEventProjector {
  project(fact: ProviderFact): SkillProviderEvent[];
}

/**
 * `SkillProviderEvent -> GatewayUplinkBusinessMessage` 投影端口。
 */
export interface SkillEventToGatewayMessageProjector {
  project(toolSessionId: string, event: SkillProviderEvent, envelope?: ToolEventEnvelopeFields): ToolEventMessage;
}

/**
 * 非 run 终态命令结果投影端口。
 */
export interface GatewayCommandResultProjector {
  projectStatus(input: { online: boolean }): StatusResponseMessage;
  projectSessionCreated(input: { welinkSessionId: string; toolSessionId: string }): SessionCreatedMessage;
}

/**
 * run terminal 投影端口。
 */
export interface RunTerminalSignalProjector {
  project(input: {
    toolSessionId: string;
    welinkSessionId?: string;
    result: ProviderTerminalResult;
  }): ToolDoneMessage | ToolErrorMessage;
}

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
            protocol: 'cloud',
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
            protocol: 'cloud',
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
            protocol: 'cloud',
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
            protocol: 'cloud',
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
            protocol: 'cloud',
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
            protocol: 'cloud',
            type: 'step.start',
            properties: {
              messageId: fact.messageId,
            },
          },
        ];
      case 'message.done':
        return [
          {
            protocol: 'cloud',
            type: 'step.done',
            properties: {
              messageId: fact.messageId,
              ...(toOptionalNumericRecord(fact.tokens) ? { tokens: toOptionalNumericRecord(fact.tokens) } : {}),
              ...(fact.cost !== undefined ? { cost: fact.cost } : {}),
              ...(fact.reason ? { reason: fact.reason } : {}),
            },
          },
        ];
      case 'session.title':
        return [
          {
            protocol: 'cloud',
            type: 'session.title',
            properties: {
              title: fact.title,
            },
          },
        ];
      case 'session.error':
        return [
          {
            protocol: 'cloud',
            type: 'session.error',
            properties: {
              error: fact.error.message,
            },
          },
        ];
    }
  }
}

/**
 * 默认 skill event -> gateway tool_event projector。
 */
export class DefaultSkillEventToGatewayMessageProjector implements SkillEventToGatewayMessageProjector {
  project(toolSessionId: string, event: SkillProviderEvent, envelope?: ToolEventEnvelopeFields): ToolEventMessage {
    return {
      type: 'tool_event',
      toolSessionId,
      ...(envelope?.subagentSessionId ? { subagentSessionId: envelope.subagentSessionId } : {}),
      ...(envelope?.subagentName ? { subagentName: envelope.subagentName } : {}),
      event,
    };
  }
}

/**
 * 默认命令结果 projector。
 */
export class DefaultGatewayCommandResultProjector implements GatewayCommandResultProjector {
  projectStatus(input: { online: boolean }): StatusResponseMessage {
    return {
      type: 'status_response',
      opencodeOnline: input.online,
    };
  }

  projectSessionCreated(input: { welinkSessionId: string; toolSessionId: string }): SessionCreatedMessage {
    return {
      type: 'session_created',
      welinkSessionId: input.welinkSessionId,
      toolSessionId: input.toolSessionId,
      session: {
        sessionId: input.toolSessionId,
      },
    };
  }
}

/**
 * 默认 run terminal projector。
 */
export class DefaultRunTerminalSignalProjector implements RunTerminalSignalProjector {
  project(input: {
    toolSessionId: string;
    welinkSessionId?: string;
    result: ProviderTerminalResult;
  }): ToolDoneMessage | ToolErrorMessage {
    if (input.result.outcome === 'completed' || input.result.outcome === 'aborted') {
      return {
        type: 'tool_done',
        toolSessionId: input.toolSessionId,
        ...(input.welinkSessionId ? { welinkSessionId: input.welinkSessionId } : {}),
      };
    }

    return {
      type: 'tool_error',
      toolSessionId: input.toolSessionId,
      ...(input.welinkSessionId ? { welinkSessionId: input.welinkSessionId } : {}),
      error: input.result.error?.message ?? 'provider_run_failed',
      ...(input.result.error?.code === 'session_not_found' ? { reason: 'session_not_found' as const } : {}),
    };
  }
}
