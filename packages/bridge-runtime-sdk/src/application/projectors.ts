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
  project(toolSessionId: string, event: SkillProviderEvent): ToolEventMessage;
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
 * skill family 默认 fact projector。
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
            family: 'skill',
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
            family: 'skill',
            type: 'tool.update',
            properties: {
              messageId: fact.messageId,
              partId: fact.partId,
              toolName: fact.toolName,
              status: fact.status,
              ...(fact.toolCallId ? { toolCallId: fact.toolCallId } : {}),
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
            family: 'skill',
            type: 'question',
            properties: {
              messageId: fact.messageId,
              partId: fact.toolCallId,
              question: fact.question,
              ...(fact.toolCallId ? { toolCallId: fact.toolCallId } : {}),
              ...(fact.header ? { header: fact.header } : {}),
              ...(fact.options?.length ? { options: fact.options } : {}),
            },
          },
        ];
      case 'permission.ask':
        return [
          {
            family: 'skill',
            type: 'permission.ask',
            properties: {
              messageId: fact.messageId,
              partId: fact.toolCallId ?? fact.permissionId,
              permissionId: fact.permissionId,
              ...(fact.permissionType ? { permType: fact.permissionType } : {}),
              ...(fact.metadata ? { metadata: fact.metadata } : {}),
            },
          },
        ];
      case 'message.start':
        return [
          {
            family: 'skill',
            type: 'step.start',
            properties: {
              messageId: fact.messageId,
            },
          },
        ];
      case 'message.done':
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
      case 'session.error':
        return [
          {
            family: 'skill',
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
  project(toolSessionId: string, event: SkillProviderEvent): ToolEventMessage {
    return {
      type: 'tool_event',
      toolSessionId,
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
    };
  }
}
