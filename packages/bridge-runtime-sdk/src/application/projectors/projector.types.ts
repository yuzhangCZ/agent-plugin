import type {
  SessionCreatedMessage,
  SkillProviderEvent,
  SlashCommandsResultMessage,
  StatusResponseMessage,
  ToolDoneMessage,
  ToolErrorMessage,
  ToolEventMessage,
} from '@agent-plugin/gateway-schema';

import type { ProviderFact, ProviderTerminalResult } from '../../domain/provider.ts';
import type { ProviderSlashCommand } from '../../domain/provider.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { ProjectableProviderFact } from './projectable-provider-fact.ts';

export type ToolEventEnvelopeFields = {
  subagentSessionId?: string;
  subagentName?: string;
};

export type GatewayOutboundSink = OutboundSink;

/**
 * `ProviderFact -> SkillProviderEvent` 投影端口。
 */
export interface FactToSkillEventProjector {
  project(fact: ProjectableProviderFact): SkillProviderEvent[];
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
  projectSlashCommands(input: {
    welinkSessionId: string;
    traceId: string;
    slashCommands: ProviderSlashCommand[];
  }): SlashCommandsResultMessage;
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
