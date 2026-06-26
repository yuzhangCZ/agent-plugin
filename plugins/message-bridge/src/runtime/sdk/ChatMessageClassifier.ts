import type {
  BusinessEntryContext,
} from './session-isolation/index.js';
import type { BusinessEntryPolicy } from '../../port/session-isolation/dto/commands/index.js';
import type {
  SlashCommand,
  SlashCommandDescriptor,
  BridgeLocalSlashCommandParser,
} from '../../port/SlashCommandControlPlanePort.js';
import { SimpleBridgeLocalSlashCommandParser } from '../../adapter/SlashCommandControlPlaneMemory.js';
import type {
  ChatActionContext,
} from './SdkChatControlPlane.js';

export interface OpenCodeNativeCommandDescriptor {
  name: string;
}

export type ListOpenCodeNativeCommands = (input: { directory?: string }) => Promise<OpenCodeNativeCommandDescriptor[]>;

export type BridgeLocalSlashClassification =
  | {
      kind: 'bridge_local';
      descriptor: SlashCommandDescriptor;
      command?: SlashCommand;
      disabledInEntry?: boolean;
      invalid?: boolean;
    }
  | { kind: 'none' };

export type OpenCodeNativeSlashClassification =
  | {
      kind: 'opencode_native';
      commandName: string;
      arguments: string;
    }
  | { kind: 'normal_chat'; fallbackReason?: string; commandName?: string };

export type SlashCommandClassification =
  | Exclude<BridgeLocalSlashClassification, { kind: 'none' }>
  | Extract<OpenCodeNativeSlashClassification, { kind: 'opencode_native' }>;

export type ChatMessageClassification =
  | { kind: 'slash'; slash: SlashCommandClassification }
  | { kind: 'normal_chat'; fallbackReason?: string; commandName?: string };

export interface ChatMessageClassifierPort {
  classify(input: {
    context: ChatActionContext;
  }): Promise<ChatMessageClassification>;
}

/**
 * SDK chat 入口的 slash 能力策略。
 */
export interface SlashCapabilityProvider {
  isAllowed(input: { policy?: BusinessEntryPolicy; command: SlashCommandDescriptor }): boolean;
}

class StaticSlashCapabilityProvider implements SlashCapabilityProvider {
  isAllowed(input: { policy?: BusinessEntryPolicy; command: SlashCommandDescriptor }): boolean {
    if (!input.policy) {
      return true;
    }
    return input.policy.allowedSlashCommands.includes(input.command.kind);
  }
}

/**
 * chat message 类型分类器。
 * @remarks 对外只暴露一次 chat 输入分类；内部按 bridge-local、OpenCode native、
 * normal chat 的优先级分类，不执行具体 command。
 */
export class ChatMessageClassifier implements ChatMessageClassifierPort {
  private readonly slashCapabilityProvider: SlashCapabilityProvider;
  private readonly bridgeLocalSlashCommandParser: BridgeLocalSlashCommandParser;

  constructor(private readonly dependencies: {
    slashCommandParser?: BridgeLocalSlashCommandParser;
    slashCapabilityProvider?: SlashCapabilityProvider;
    listNativeCommands?: ListOpenCodeNativeCommands;
  }) {
    this.bridgeLocalSlashCommandParser = dependencies.slashCommandParser ?? new SimpleBridgeLocalSlashCommandParser();
    this.slashCapabilityProvider = dependencies.slashCapabilityProvider ?? new StaticSlashCapabilityProvider();
  }

  async classify(input: {
    context: ChatActionContext;
  }): Promise<ChatMessageClassification> {
    const { context } = input;
    const slashCandidateText = normalizeSlashCandidateText(context.message.text, context.entryContext);

    const bridgeLocalClassification = this.classifyBridgeLocalSlash({
      text: slashCandidateText,
      entryContext: context.entryContext,
    });
    if (bridgeLocalClassification.kind === 'bridge_local') {
      return { kind: 'slash', slash: bridgeLocalClassification };
    }

    const openCodeNativeClassification = await this.classifyOpenCodeNativeSlash({
      text: slashCandidateText,
      ...(context.effectiveDirectory ? { directory: context.effectiveDirectory } : {}),
    });
    if (openCodeNativeClassification.kind === 'opencode_native') {
      return { kind: 'slash', slash: openCodeNativeClassification };
    }

    this.logNativePreflightFallback(context, openCodeNativeClassification);
    return openCodeNativeClassification;
  }

  private classifyBridgeLocalSlash(input: {
    text: string;
    entryContext?: BusinessEntryContext;
  }): BridgeLocalSlashClassification {
    const parseResult = this.bridgeLocalSlashCommandParser.tryParse({
      text: input.text,
    });

    if (parseResult.kind === 'none') {
      return { kind: 'none' };
    }

    const descriptor = parseResult.kind === 'matched'
      ? { kind: parseResult.command.kind }
      : parseResult.command;

    const allowed = this.slashCapabilityProvider.isAllowed({
      policy: input.entryContext?.policy,
      command: descriptor,
    });
    if (!allowed) {
      return {
        kind: 'bridge_local',
        descriptor,
        disabledInEntry: true,
      };
    }

    if (parseResult.kind === 'invalid') {
      return {
        kind: 'bridge_local',
        descriptor,
        invalid: true,
      };
    }

    return {
      kind: 'bridge_local',
      descriptor,
      command: parseResult.command,
    };
  }

  private async classifyOpenCodeNativeSlash(input: {
    text: string;
    directory?: string;
  }): Promise<OpenCodeNativeSlashClassification> {
    const nativeCommand = parseNativeSlash(input.text);
    if (!nativeCommand) {
      return { kind: 'normal_chat' };
    }

    if (!this.dependencies.listNativeCommands) {
      return {
        kind: 'normal_chat',
        fallbackReason: 'session.command_unavailable',
        commandName: nativeCommand.commandName,
      };
    }

    const commands = await this.dependencies.listNativeCommands({
      ...(input.directory ? { directory: input.directory } : {}),
    });

    if (!commands.some((command) => command.name === nativeCommand.commandName)) {
      return {
        kind: 'normal_chat',
        fallbackReason: 'command_not_found',
        commandName: nativeCommand.commandName,
      };
    }

    return {
      kind: 'opencode_native',
      commandName: nativeCommand.commandName,
      arguments: nativeCommand.arguments ?? '',
    };
  }

  private logNativePreflightFallback(
    context: ChatActionContext,
    classification: Extract<OpenCodeNativeSlashClassification, { kind: 'normal_chat' }>,
  ): void {
    if (!classification.fallbackReason || !classification.commandName) {
      return;
    }
    context.logger?.info?.('sdk_chat_classifier.native_command_preflight_fallback', {
      toolSessionId: context.anchor,
      runId: context.message.runId,
      commandName: classification.commandName,
      reason: classification.fallbackReason,
    });
  }
}

function normalizeSlashCandidateText(text: string, entryContext: BusinessEntryContext | undefined): string {
  const normalized = text.trim();
  if (!isImGroupEntry(entryContext)) {
    return normalized;
  }
  return normalized.replace(/^@\S+\s+/, '').trim();
}

function parseNativeSlash(text: string): { commandName: string; arguments?: string } | undefined {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return undefined;
  }
  const commandName = match[1]?.trim();
  if (!commandName) {
    return undefined;
  }
  const args = match[2]?.trim();
  return {
    commandName,
    ...(args ? { arguments: args } : {}),
  };
}

function isImGroupEntry(entryContext: BusinessEntryContext | undefined): boolean {
  const entryKey = entryContext?.entryKey;
  return entryKey?.businessSessionDomain.toLowerCase() === 'im'
    && entryKey.businessSessionType.toLowerCase() === 'group';
}
