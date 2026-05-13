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
    assistantId?: string;
    logger?: BridgeLogger;
  }): Promise<
    | { kind: 'chat_forwarded'; sessionId: string }
    | { kind: 'slash_completed' }
  > {
    const command = this.dependencies.slashCommandParser.tryParse(input.text);
    if (command) {
      try {
        const context = await this.dependencies.contextResolver.resolve(input.anchor, input.logger);
        await this.dependencies.slashCommandOrchestrator.execute({
          command,
          context,
        });
      } catch (error) {
        await this.dependencies.slashCommandOrchestrator.completeFailure({
          command,
          anchor: input.anchor,
          error,
        });
        throw new HandledSlashCommandFailure(error);
      }
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
