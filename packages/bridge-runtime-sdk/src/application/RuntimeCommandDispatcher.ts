import type { RuntimeCommand } from '../domain/runtime-command.ts';
import type { RuntimeObservation } from './runtime-observation.ts';
import type { RuntimeUseCase } from './usecases.ts';

/**
 * runtime 命令分发器；仅负责路由与 use case 装配。
 */
export class RuntimeCommandDispatcher {
  private readonly useCases: Record<RuntimeCommand['kind'], RuntimeUseCase>;
  private readonly observation: RuntimeObservation;

  constructor(useCases: Record<RuntimeCommand['kind'], RuntimeUseCase>, observation: RuntimeObservation) {
    this.useCases = useCases;
    this.observation = observation;
  }

  /**
   * 执行单个 runtime command。
   */
  async dispatch(command: RuntimeCommand): Promise<void> {
    const context = {
      welinkSessionId: 'source' in command && 'welinkSessionId' in command.source ? command.source.welinkSessionId : undefined,
      toolSessionId: 'source' in command
        && 'payload' in command.source
        && command.source.payload
        && typeof command.source.payload === 'object'
        && 'toolSessionId' in command.source.payload
        ? (command.source.payload as { toolSessionId?: string }).toolSessionId
        : undefined,
    };
    this.observation.commandDispatched(command.kind, command.traceId, context);
    try {
      await this.useCases[command.kind].execute(command as never);
      this.observation.commandCompleted(command.kind, command.traceId, context);
    } catch (error) {
      this.observation.commandFailed(command.kind, command.traceId, error, undefined, context);
      throw error;
    }
  }
}
