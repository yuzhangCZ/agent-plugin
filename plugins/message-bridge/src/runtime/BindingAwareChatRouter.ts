import type {
  HostPromptExecutionPort,
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
    isGroupChat?: boolean;
    assistantId?: string;
    logger?: BridgeLogger;
  }): Promise<
    | { kind: 'chat_forwarded'; sessionId: string }
    | { kind: 'slash_completed' }
  > {
    const parseResult = this.dependencies.slashCommandParser.tryParse({
      text: input.text,
      isGroupChat: input.isGroupChat === true,
    });
    if (parseResult.kind === 'matched') {
      try {
        const context = await this.dependencies.contextResolver.resolve(input.anchor, input.logger);
        await this.dependencies.slashCommandOrchestrator.execute({
          command: parseResult.command,
          context,
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

    const context = await this.dependencies.contextResolver.resolve(input.anchor, input.logger);

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
}
