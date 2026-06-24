import type {
  BusinessEntryContext,
} from './session-isolation/index.js';
import type {
  ChatExecutionContext,
  ChatExecutionContextResolver,
  SessionIsolationSlashCommandExecutionPort,
} from './SdkChatControlPlane.js';
import type { BridgeLogger } from '../AppLogger.js';
import type {
  HostSessionCreateContext,
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from '../../port/SlashCommandControlPlanePort.js';
import type { SlashCommandExecutor } from '../../usecase/SlashCommandExecutor.js';

export interface SlashCommandExecutionRouterInput {
  anchor: string;
  command: SlashCommand;
  entryContext?: BusinessEntryContext;
  createContext?: HostSessionCreateContext;
  directory?: string;
  ensuredContext?: ChatExecutionContext;
  logger?: BridgeLogger;
}

export interface SlashCommandExecutionRouterPort {
  execute(input: SlashCommandExecutionRouterInput): Promise<SlashCommandResult>;
}

/**
 * bridge-local slash 命令执行分发器。
 * @remarks 会话隔离命令优先走 session-isolation 控制面，其余命令回落到 legacy 执行器。
 */
export class SlashCommandExecutionRouter implements SlashCommandExecutionRouterPort {
  constructor(private readonly dependencies: {
    slashCommandExecutor: SlashCommandExecutor;
    sessionIsolationSlashCommandExecutor?: SessionIsolationSlashCommandExecutionPort;
    contextResolver: ChatExecutionContextResolver;
  }) {}

  async execute(input: SlashCommandExecutionRouterInput): Promise<SlashCommandResult> {
    const sessionIsolationResult = await this.executeSessionIsolationCommand(input);
    if (sessionIsolationResult) {
      return sessionIsolationResult;
    }
    return this.executeLegacyCommand(input);
  }

  private async executeSessionIsolationCommand(input: SlashCommandExecutionRouterInput): Promise<SlashCommandResult | undefined> {
    if (!input.entryContext || !this.dependencies.sessionIsolationSlashCommandExecutor) {
      return undefined;
    }
    if (!this.isSessionIsolationCommand(input.command)) {
      return undefined;
    }
    return this.dependencies.sessionIsolationSlashCommandExecutor.execute({
      command: input.command,
      anchor: input.anchor,
      ensuredContext: input.ensuredContext ?? {
        opencodeSessionId: '',
        bootstrapSource: 'bootstrap_created',
      },
      entryContext: input.entryContext,
      ...(input.createContext ? { createContext: input.createContext } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    });
  }

  private async executeLegacyCommand(input: SlashCommandExecutionRouterInput): Promise<SlashCommandResult> {
    const context = input.ensuredContext ?? await this.dependencies.contextResolver.resolveForChat(
      input.anchor,
      input.createContext,
      input.logger,
    );
    const commandContext: SlashCommandContext = {
      anchor: input.anchor,
      activeOpencodeSessionId: context.opencodeSessionId,
      scope: context.scope,
      modelOverride: context.modelOverride,
      bootstrapSource: context.bootstrapSource,
    };
    return this.dependencies.slashCommandExecutor.execute(
      input.command,
      commandContext,
      input.createContext,
    );
  }

  private isSessionIsolationCommand(command: SlashCommand): command is Extract<SlashCommand, { kind: 'new' | 'sessions' | 'session' }> {
    return command.kind === 'new' || command.kind === 'sessions' || command.kind === 'session';
  }
}
