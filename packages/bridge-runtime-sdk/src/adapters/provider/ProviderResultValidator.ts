import type {
  ProviderListSlashCommandsResult,
  ProviderSlashCommand,
} from '../../domain/provider.ts';

const SLASH_COMMAND_PATTERN = /^\/[^\s/]+$/u;

/**
 * Provider 返回结果进入 SDK 内部前的契约校验器。
 * @remarks 对可降级的列表项执行 item 级过滤和字段规范化，避免单个非法项阻断整条上行消息。
 */
export class ProviderResultValidator {
  validateListSlashCommandsResult(result: ProviderListSlashCommandsResult): ProviderListSlashCommandsResult {
    return {
      slashCommands: this.validateSlashCommands(result.slashCommands),
    };
  }

  private validateSlashCommands(slashCommands: ProviderSlashCommand[]): ProviderSlashCommand[] {
    const validated: ProviderSlashCommand[] = [];
    for (const slashCommand of slashCommands) {
      if (!SLASH_COMMAND_PATTERN.test(slashCommand.command)) {
        continue;
      }
      const description = slashCommand.description.trim();
      validated.push({
        command: slashCommand.command,
        description,
      });
    }
    return validated;
  }
}
