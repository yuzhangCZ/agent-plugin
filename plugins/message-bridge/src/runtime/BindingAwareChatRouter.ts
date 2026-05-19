import type {
  HostPromptExecutionPort,
  SlashCommand,
  SlashCommandContextResolver,
  SlashCommandParser,
} from '../port/SlashCommandControlPlanePort.js';
import type { DefaultSlashCommandOrchestrator } from '../usecase/SlashCommandOrchestrator.js';
import type { BridgeLogger } from '../types/logger.js';

/** slash 失败已完成统一回包；runtime 仅需处理副作用，不再重复上送 tool_error。 */
export class HandledSlashCommandFailure extends Error {
  constructor(readonly sourceError: unknown) {
    super('slash_command.failure_handled');
  }
}

/** chat 与 slash 共用入口：先拿 binding，再分发到数据面或控制面。 */
export class BindingAwareChatRouter {
  constructor(private readonly dependencies: {
    contextResolver: SlashCommandContextResolver;
    slashCommandParser: SlashCommandParser;
    slashCommandOrchestrator: DefaultSlashCommandOrchestrator;
    hostPromptExecutionPort: HostPromptExecutionPort;
  }) {}

  async route(input: {
    anchor: string;
    text: string;
    assistantId?: string;
    imGroupId?: string;
    logger?: BridgeLogger;
  }): Promise<
    | { kind: 'chat_forwarded'; sessionId: string }
    | { kind: 'slash_completed' }
  > {
    const createContext = {
      assistantId: input.assistantId,
      imGroupId: input.imGroupId,
    };
    const isGroupChat = Boolean(input.imGroupId?.trim());
    const parseResult = this.dependencies.slashCommandParser.tryParse({
      text: input.text,
      isGroupChat,
    });
    if (parseResult.kind === 'matched') {
      if (isGroupChat && this.isGroupDisabledCommand(parseResult.command)) {
        try {
          await this.dependencies.slashCommandOrchestrator.completeFailure({
            command: parseResult.command,
            anchor: input.anchor,
            error: {
              code: 'command_disabled_in_group_chat',
              reasonKey: 'command_not_available_in_group_chat',
            },
            ...(input.logger ? { logger: input.logger } : {}),
          });
        } catch (error) {
          throw new HandledSlashCommandFailure(error);
        }
        return { kind: 'slash_completed' };
      }
      try {
        const context = await this.dependencies.contextResolver.resolve(input.anchor, createContext, input.logger);
        await this.dependencies.slashCommandOrchestrator.execute({
          command: parseResult.command,
          context,
          createContext,
          ...(input.logger ? { logger: input.logger } : {}),
        });
      } catch (error) {
        await this.dependencies.slashCommandOrchestrator.completeFailure({
          command: parseResult.command,
          anchor: input.anchor,
          error,
          ...(input.logger ? { logger: input.logger } : {}),
        });
        throw new HandledSlashCommandFailure(error);
      }
      return { kind: 'slash_completed' };
    }

    if (parseResult.kind === 'invalid') {
      await this.dependencies.slashCommandOrchestrator.completeFailure({
        command: parseResult.command,
        anchor: input.anchor,
        error: { code: 'invalid_command' },
        ...(input.logger ? { logger: input.logger } : {}),
      });
      return { kind: 'slash_completed' };
    }

    const context = await this.dependencies.contextResolver.resolve(
      input.anchor,
      createContext,
      input.logger,
    );

    if (!context.activeOpencodeSessionId) {
      throw new Error(`active session missing for anchor=${input.anchor}`);
    }

    await this.dependencies.hostPromptExecutionPort.prompt({
      sessionId: context.activeOpencodeSessionId,
      text: input.text,
      assistantId: input.assistantId,
      modelOverride: context.modelOverride,
      ...(input.logger ? { logger: input.logger } : {}),
    });
    return {
      kind: 'chat_forwarded',
      sessionId: context.activeOpencodeSessionId,
    };
  }

  /** 群聊下禁用显式列会话和切会话，避免绕开当前会话隔离边界。 */
  private isGroupDisabledCommand(command: SlashCommand): boolean {
    return command.kind === 'sessions' || command.kind === 'session';
  }
}
