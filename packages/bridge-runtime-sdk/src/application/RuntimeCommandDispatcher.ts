import type { RuntimeCommand } from '../domain/runtime-command.ts';
import type { RuntimeUseCase } from './usecases.ts';

/**
 * runtime 命令分发器；仅负责路由与 use case 装配。
 */
export class RuntimeCommandDispatcher {
  private readonly useCases: Record<RuntimeCommand['kind'], RuntimeUseCase>;

  constructor(useCases: Record<RuntimeCommand['kind'], RuntimeUseCase>) {
    this.useCases = useCases;
  }

  /**
   * 执行单个 runtime command。
   */
  async dispatch(command: RuntimeCommand): Promise<void> {
    await this.useCases[command.kind].execute(command as never);
  }
}
