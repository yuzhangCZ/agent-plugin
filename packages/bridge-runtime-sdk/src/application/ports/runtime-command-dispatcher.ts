import type { RuntimeCommand, RuntimeCommandResultByType } from '../../domain/runtime-command.ts';

/**
 * Runtime 命令调度边界。
 */
export interface RuntimeCommandDispatcher {
  dispatch<TCommand extends RuntimeCommand>(
    command: TCommand,
  ): Promise<RuntimeCommandResultByType[TCommand['type']]>;
}
