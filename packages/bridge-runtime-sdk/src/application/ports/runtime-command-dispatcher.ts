import type { RuntimeCommand } from '../../domain/runtime-command.ts';

/**
 * Runtime 命令调度边界。
 */
export interface RuntimeCommandDispatcher {
  dispatch(command: RuntimeCommand): Promise<void>;
}
